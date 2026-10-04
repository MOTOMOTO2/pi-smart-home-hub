/**
 * Mutable state shared by the demo simulators. Keeping it in one place means
 * the fake devices behave like a real house: turning the TV off in the UI is
 * reflected by the next poll, a scene that dims the lights and switches input
 * actually changes both, and the Xbox answers discovery only while awake.
 */
export interface SimNanoleafState {
  on: boolean;
  brightness: number;
  hue: number;
  sat: number;
  ct: number;
  colorMode: string;
  effect: string;
  effectsList: string[];
  identifyCount: number;
}

export interface SimRokuState {
  on: boolean;
  volume: number;
  muted: boolean;
  activeAppId: string;
  activeApp: string;
  playState: 'none' | 'play' | 'pause';
  lastKey: string | null;
  typed: string;
}

export interface SimEcobeeState {
  hvacMode: string;
  actualTemperature: number; // tenths of F
  actualHumidity: number;
  desiredHeat: number; // tenths of F
  desiredCool: number; // tenths of F
  fanMode: string;
  equipmentStatus: string;
  holdActive: boolean;
  pin: string | null;
  pinCode: string | null;
  pinClaimed: boolean;
  accessToken: string;
  refreshToken: string;
}

export interface SimRingEvent {
  id: number;
  kind: string;
  created_at: string;
  answered: boolean;
  duration: number;
}

export interface SimRingState {
  deviceId: number;
  description: string;
  battery: number;
  signalStrength: number;
  firmware: string;
  events: SimRingEvent[];
  activeDing: boolean;
  lightOn: boolean;
  sirenOn: boolean;
  snapshotRequestedAt: number;
  twoFactorPending: boolean;
  accessToken: string;
  refreshToken: string;
  nextEventId: number;
}

export interface SimXboxState {
  on: boolean;
  name: string;
  liveId: string;
  uuid: string;
}

export interface SimPcState {
  on: boolean;
  hostname: string;
  platform: string;
  bootedAt: number;
  wakeCount: number;
}

export class SimWorld {
  readonly nanoleaf: SimNanoleafState = {
    on: true,
    brightness: 62,
    hue: 28,
    sat: 92,
    ct: 4200,
    colorMode: 'effect',
    effect: 'Northern Lights',
    effectsList: [
      'Northern Lights',
      'Nemo',
      'Forest',
      'Date Night',
      'Fireplace',
      'Inner Peace',
      'Rhythmic Northern Lights',
      'Snowfall',
    ],
    identifyCount: 0,
  };

  readonly roku: SimRokuState = {
    on: true,
    volume: 14,
    muted: false,
    activeAppId: 'tvinput.hdmi2',
    activeApp: 'HDMI2',
    playState: 'none',
    lastKey: null,
    typed: '',
  };

  readonly ecobee: SimEcobeeState = {
    hvacMode: 'heat',
    actualTemperature: 694,
    actualHumidity: 38,
    desiredHeat: 700,
    desiredCool: 755,
    fanMode: 'auto',
    equipmentStatus: 'heatPump',
    holdActive: false,
    pin: null,
    pinCode: null,
    pinClaimed: false,
    accessToken: 'demo-ecobee-access',
    refreshToken: 'demo-ecobee-refresh',
  };

  readonly ring: SimRingState = {
    deviceId: 90210,
    description: 'Front Door',
    battery: 78,
    signalStrength: -54,
    firmware: 'Up to Date',
    events: [],
    activeDing: false,
    lightOn: false,
    sirenOn: false,
    snapshotRequestedAt: Date.now(),
    twoFactorPending: false,
    accessToken: 'demo-ring-access',
    refreshToken: 'demo-ring-refresh-token',
    nextEventId: 7000,
  };

  readonly xbox: SimXboxState = {
    on: false,
    name: 'LIVING ROOM XBOX',
    liveId: 'FD00A1B2C3D4E5F6',
    uuid: 'DE305D54-75B4-431B-ADB2-EB6B9E546014',
  };

  readonly pc: SimPcState = {
    on: false,
    hostname: 'battlestation',
    platform: 'win32',
    bootedAt: Date.now(),
    wakeCount: 0,
  };

  constructor() {
    const now = Date.now();
    this.ring.events = [
      this.makeEvent('motion', now - 7 * 60_000, false),
      this.makeEvent('ding', now - 52 * 60_000, true),
      this.makeEvent('motion', now - 95 * 60_000, false),
      this.makeEvent('motion', now - 4 * 3_600_000, false),
    ];
  }

  private makeEvent(kind: string, at: number, answered: boolean): SimRingEvent {
    this.ring.nextEventId += 1;
    return {
      id: this.ring.nextEventId,
      kind,
      created_at: new Date(at).toISOString(),
      answered,
      duration: kind === 'ding' ? 28 : 16,
    };
  }

  /** Used by the demo doorbell button in the UI and by tests. */
  pushRingEvent(kind: 'ding' | 'motion'): SimRingEvent {
    const event = this.makeEvent(kind, Date.now(), false);
    this.ring.events.unshift(event);
    this.ring.events = this.ring.events.slice(0, 25);
    this.ring.activeDing = kind === 'ding';
    if (kind === 'ding') {
      setTimeout(() => {
        this.ring.activeDing = false;
      }, 20_000).unref?.();
    }
    return event;
  }
}
