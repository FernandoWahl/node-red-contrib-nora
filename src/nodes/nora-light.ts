import { BehaviorSubject, combineLatest, Subject } from 'rxjs';
import { publishReplay, refCount, skip, switchMap, takeUntil, tap } from 'rxjs/operators';
import { NodeInterface } from '../node';
import { NoraService } from '../nora';
import { convertValueType, getValue } from './util';

interface LightDeviceState {
    on: boolean;
    brightness?: number;
    color?: {
        spectrumHSV: {
            hue: number;
            saturation: number;
            value: number;
        }
    };
}

module.exports = function (RED) {
    RED.nodes.registerType('nora-light', function (this: NodeInterface, config) {
        RED.nodes.createNode(this, config);

        const noraConfig = RED.nodes.getNode(config.nora);
        if (!noraConfig || !noraConfig.token) { return; }

        const brightnessControl = !!config.brightnesscontrol;
        const statepayload = !!config.statepayload;
        const colorControl = !!config.lightcolor;
        const { value: onValue, type: onType } = convertValueType(RED, config.onvalue, config.onvalueType, { defaultValue: true });
        const { value: offValue, type: offType } = convertValueType(RED, config.offvalue, config.offvalueType, { defaultValue: false });
        const brightnessOverride = Math.max(0, Math.min(100, Math.round(config.brightnessoverride))) || 0;

        const close$ = new Subject();
        const initialState: LightDeviceState = {
            on: false
        };
        if (brightnessControl) {
            initialState.brightness = 100;
        }
        if (colorControl) {
            initialState.color = {
                spectrumHSV: {
                    hue: 0,
                    saturation: 0,
                    value: 1,
                },
            };
        }
        const state$ = new BehaviorSubject(initialState);
        const stateString$ = new Subject<string>();

        const device$ = NoraService
            .getService(RED)
            .getConnection(noraConfig, this, stateString$)
            .pipe(
                switchMap(connection => connection.addDevice(config.id, {
                    type: 'light',
                    brightnessControl: brightnessControl,
                    colorControl: colorControl,
                    name: config.devicename,
                    roomHint: config.roomhint || undefined,
                    state: {
                        online: true,
                        ...state$.value,
                    },
                })),
                publishReplay(1),
                refCount(),
                takeUntil(close$),
            );

        combineLatest(device$, state$)
            .pipe(
                tap(([_, state]) => notifyState(state)),
                skip(1),
                takeUntil(close$)
            )
            .subscribe(([device, state]) => device.updateState({ ...state }));

        device$.pipe(
            switchMap(d => d.errors$),
            takeUntil(close$),
        ).subscribe(err => this.warn(err));

        device$.pipe(
            switchMap(d => d.state$),
            takeUntil(close$),
        ).subscribe((state: LightDeviceState) => {
            notifyState(state);
            state$.value.on = state.on;
            if (brightnessControl) {
                state$.value.brightness = state.brightness;
            }
            if (colorControl) {
                state$.value.color = state.color;
            }

            if (!brightnessControl) {
                const value = state.on;
                this.send({
                    payload: getValue(RED, this, value ? onValue : offValue, value ? onType : offType),
                    topic: config.topic
                });
            } else {
                if (statepayload) {
                    var payload =  null
                    if (colorControl) {
                        payload =  {
                            on: state.on,
                            brightness: state.brightness,
                            color: state.color
                        };
                    } else {
                        payload = {
                            on: state.on,
                            brightness: state.brightness,
                        };
                    }
                    this.send({
                        payload: payload,
                        topic: config.topic
                    });
                } else {
                    this.send({
                        payload: state.on ? state.brightness : 0,
                        topic: config.topic
                    });
                }
            }
        });

        this.on('input', msg => {
            if (config.passthru) {
                this.send(msg);
            }
            if (!brightnessControl) {
                const myOnValue = getValue(RED, this, onValue, onType);
                const myOffValue = getValue(RED, this, offValue, offType);
                if (RED.util.compareObjects(myOnValue, msg.payload)) {
                    state$.next({ ...state$.value, on: true });
                } else if (RED.util.compareObjects(myOffValue, msg.payload)) {
                    state$.next({ ...state$.value, on: false });
                }
            } else {
                if (statepayload) {
                    if (typeof msg.payload !== 'object' || !msg.payload) {
                        this.error('Payload must be an object like { [on]: true/false, [brightness]: 0-100, [color]: { [spectrumHSV] : { [hue]: 0-360, [saturation]:0-1, [value]:0-1 } } }');
                    } else {
                        const state = { ...state$.value };
                        let update = false;
                        if ('color' in msg.payload && typeof msg.payload.color === 'object'
                            && 'spectrumHSV' in msg.payload.color && typeof msg.payload.color.spectrumHSV === 'object'
                            && 'hue' in msg.payload.color.spectrumHSV && typeof msg.payload.color.spectrumHSV.hue === 'number' && isFinite(msg.payload.color.spectrumHSV.hue)
                            && 'saturation' in msg.payload.color.spectrumHSV && typeof msg.payload.color.spectrumHSV.saturation === 'number' && isFinite(msg.payload.color.spectrumHSV.saturation)
                            && 'value' in msg.payload.color.spectrumHSV && typeof msg.payload.color.spectrumHSV.value === 'number' && isFinite(msg.payload.color.spectrumHSV.value)) {

                            state.color = {
                                spectrumHSV : {
                                    hue: Math.max(0, Math.min(360, msg.payload.color.spectrumHSV.hue)),
                                    saturation: Math.max(0, Math.min(1, msg.payload.color.spectrumHSV.saturation)),
                                    value: Math.max(0, Math.min(1, msg.payload.color.spectrumHSV.value)),
                                }
                            }
                            update = true;
                        }
                        if ('brightness' in msg.payload && typeof msg.payload.brightness === 'number' && isFinite(msg.payload.brightness)) {
                            state.brightness = Math.max(1, Math.min(100, Math.round(msg.payload.brightness)));
                            update = true;
                        }
                        if ('on' in msg.payload && typeof msg.payload.on === 'boolean') {
                            state.on = msg.payload.on;
                            update = true;
                        }
                        if (update) { state$.next(state); }
                    }
                } else {
                    const brightness = Math.max(0, Math.min(100, Math.round(msg.payload)));
                    if (isFinite(brightness)) {
                        if (brightness === 0) {
                            if (brightnessOverride !== 0) {
                                state$.next({
                                    ...state$.value,
                                    on: false,
                                    brightness: brightnessOverride,
                                });
                            } else {
                                state$.next({
                                    ...state$.value,
                                    on: false,
                                });
                            }
                        } else {
                            state$.next({
                                ...state$.value,
                                on: true,
                                brightness: brightness,
                            });
                        }
                    } else {
                        this.error('Payload must be a number in range 0-100');
                    }
                }
            }
        });

        this.on('close', () => {
            close$.next();
            close$.complete();
        });

        function notifyState(state: LightDeviceState) {
            let stateString = state.on ? 'on' : 'off';
            if (brightnessControl) {
                stateString += ` ${state.brightness}`;
            }
            if (colorControl) {
                stateString += ` hue: ${Number(state.color.spectrumHSV.hue).toFixed(2)}°`;
                stateString += ` sat: ${Number(state.color.spectrumHSV.saturation * 100).toFixed(2)}%`;
                stateString += ` val: ${Number(state.color.spectrumHSV.value * 100).toFixed(2)}%`;
            }

            stateString$.next(`(${stateString})`);
        }
    });
};

