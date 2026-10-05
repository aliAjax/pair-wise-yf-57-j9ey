// 离线巡护数据模型：观察记录、轨迹点、样本
// 同步采用字段级三向合并：本地值 vs 站里值 vs 上次同步基线(base)

export type Role = 'ranger' | 'manager';

export type Risk = 'low' | 'medium' | 'high';

// queued：在本地队列里等上传；failed：上次同步没传完；conflict：同字段两边都改了；synced：已与站里一致
export type SyncState = 'queued' | 'failed' | 'conflict' | 'synced';

export type EntityKind = 'observation' | 'point' | 'sample';

/** 一个字段两边都改且改后不一致：两份内容都留着，等负责人裁决 */
export interface FieldConflict {
  local: string;
  remote: string;
}

interface SyncShape {
  sync: SyncState;
  conflicts: Record<string, FieldConflict>;
  dirtyFields: string[];
}

export interface ObservationDoc extends SyncShape {
  kind: 'observation';
  clientId: string;
  time: string;
  note: string;
  risk: Risk;
  reviewed: boolean; // 负责人复核结论（经理域，只跟站里走）
  pointId: string | null;
  // 巡护员可改字段：note、risk
  base: { note: string; risk: Risk } | null; // 上次同步时的基线，null 表示站里还没有
}

export interface PointDoc extends SyncShape {
  kind: 'point';
  clientId: string;
  latitude: number;
  longitude: number;
  at: string;
  source: 'gps' | 'manual';
  coordVersion: number; // 坐标版本：一变就级联作废依赖它的样本核验/观察复核
  // 可合并字段：latitude、longitude
  base: { latitude: number; longitude: number } | null;
}

export type SampleStatus = 'submitted' | 'verified';

export interface SampleDoc extends SyncShape {
  kind: 'sample';
  clientId: string;
  code: string;
  species: string;
  count: number;
  pointId: string;
  status: SampleStatus; // 经理域：submitted 待核验 / verified 已核验
  verifyNote: string; // 核验结论；坐标一变就作废并按新坐标重算
  verifiedBy: string;
  coordVersion: number; // 核验时所依据的轨迹点坐标版本
  // 巡护员可改字段：code、species、count
  base: { code: string; species: string; count: number } | null;
}

// ---- 站里（站点服务器）保存的版本 ----

export interface StationObservation {
  clientId: string;
  time: string;
  note: string;
  risk: Risk;
  reviewed: boolean;
  pointId: string | null;
}

export interface StationPoint {
  clientId: string;
  latitude: number;
  longitude: number;
  at: string;
  source: 'gps' | 'manual';
  coordVersion: number;
}

export interface StationSample {
  clientId: string;
  code: string;
  species: string;
  count: number;
  pointId: string;
  status: SampleStatus;
  verifyNote: string;
  verifiedBy: string;
  coordVersion: number;
}

export interface StationState {
  observations: StationObservation[];
  points: StationPoint[];
  samples: StationSample[];
}

export interface AppState {
  role: Role;
  online: boolean;
  failNextMidSync: boolean;
  observations: ObservationDoc[];
  points: PointDoc[];
  samples: SampleDoc[];
  notice: string | null;
  lastSyncReport: string | null;
}

export const RISK_LABEL: Record<Risk, string> = { low: '低', medium: '中', high: '高' };
export const SYNC_LABEL: Record<SyncState, string> = {
  queued: '待同步',
  failed: '未传完',
  conflict: '冲突待裁决',
  synced: '已同步'
};
