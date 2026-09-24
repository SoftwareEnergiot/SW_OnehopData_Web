// Saved remote configs: one per device, keyed by the canonical UID
// ("00124B0038A83BF0").

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildConfigFileV0,
  type RemoteConfigV0,
} from "@/lib/remote-config";

export const DEVICE_CONFIG_TABLE = "device_config";

/** One row of `device_config`. */
export interface DeviceConfigRecord {
  device_uid: string;
  /** File format version; 0 is the only one so far. */
  config_version: number;
  /** The config as edited, the seven v0 keys. */
  config: RemoteConfigV0;
  /** Relax the interval limits for Debug firmware on the bench. */
  lab_limits: boolean;
  /** The exact file served to the device. */
  file: string;
  /** Its CRC, as line 10 spells it: 8 uppercase hex digits. */
  crc32: string;
  updated_at: string;
}

const COLUMNS = "device_uid,config_version,config,lab_limits,file,crc32,updated_at";

export async function listDeviceConfigs(
  supabase: SupabaseClient,
): Promise<DeviceConfigRecord[]> {
  const { data, error } = await supabase.from(DEVICE_CONFIG_TABLE).select(COLUMNS);
  if (error) throw new Error(error.message);
  return (data ?? []) as DeviceConfigRecord[];
}

export async function getDeviceConfig(
  supabase: SupabaseClient,
  deviceUid: string,
): Promise<DeviceConfigRecord | null> {
  const { data, error } = await supabase
    .from(DEVICE_CONFIG_TABLE)
    .select(COLUMNS)
    .eq("device_uid", deviceUid)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as DeviceConfigRecord | null) ?? null;
}

/**
 * Save a validated config for a device, replacing whatever it had. The file is
 * generated here, from the config, so the stored file and CRC always match it.
 */
export async function saveDeviceConfig(
  supabase: SupabaseClient,
  deviceUid: string,
  config: RemoteConfigV0,
  labLimits: boolean,
): Promise<DeviceConfigRecord> {
  const file = buildConfigFileV0(config);
  const record: DeviceConfigRecord = {
    device_uid: deviceUid,
    config_version: 0,
    config,
    lab_limits: labLimits,
    file: file.text,
    crc32: file.crc32Hex,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from(DEVICE_CONFIG_TABLE)
    .upsert(record, { onConflict: "device_uid" })
    .select(COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return data as DeviceConfigRecord;
}
