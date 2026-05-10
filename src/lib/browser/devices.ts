import type { DeviceDescriptor } from './types.js';

export const DEVICES: Record<string, DeviceDescriptor> = {
  'iPhone 14': {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  },
  'iPad': {
    width: 768,
    height: 1024,
    deviceScaleFactor: 2,
    mobile: true,
  },
  'MacBook Pro': {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  },
};

export function getDevice(name: string): DeviceDescriptor | undefined {
  const key = Object.keys(DEVICES).find(
    (k) => k.toLowerCase() === name.toLowerCase()
  );
  return key ? DEVICES[key] : undefined;
}

export function listDevices(): string[] {
  return Object.keys(DEVICES);
}
