// 野外巡护离线调查 —— 领域类型定义

export type Role = 'ranger' | 'manager';

/** 同步状态：本地新建 / 待上传 / 上传中 / 已同步 / 冲突待负责人确认 / 失败待重试 */
export type SyncState = 'local' | 'queued' | 'uploading' | 'synced' | 'conflict' | 'failed';

export type RiskLevel = 'low' | 'medium' | 'high';

export type SampleStatus = 'draft' | 'submitted' | 'verified';

export type VerificationConclusion = 'normal' | 'abnormal';

/** 字段级冲突：两边改到同一字段且值不同，留待负责人确认 */
export interface FieldConflict {
  field: string;
  label: string;
  localValue: unknown;
  serverValue: unknown;
}

/** 样本核验结论（由坐标重算得出） */
export interface Verification {
  conclusion: VerificationConclusion;
  at: string;
}

export interface PatrolObservation {
  id: string;
  time: string;
  note: string;
  risk: RiskLevel;
  sync: SyncState;
  reviewed: boolean;
  /** 最近一次同步成功时的快照（三向合并的 base） */
  base?: Pick<PatrolObservation, 'note' | 'risk'>;
  conflicts?: FieldConflict[];
  attempts?: number;
}

export interface TrackPoint {
  id: string;
  latitude: number;
  longitude: number;
  at: string;
  source: 'gps' | 'manual';
  sync: SyncState;
  base?: Pick<TrackPoint, 'latitude' | 'longitude'>;
  conflicts?: FieldConflict[];
  attempts?: number;
}

export interface Sample {
  id: string;
  code: string;
  species: string;
  count: number;
  status: SampleStatus;
  pointId?: string;
  sync: SyncState;
  reviewed: boolean;
  verification?: Verification | null;
  base?: Pick<Sample, 'code' | 'species' | 'count' | 'pointId'>;
  conflicts?: FieldConflict[];
  attempts?: number;
}

/** 站里版本（服务端快照），按 id 索引，用于三向合并与幂等 upsert */
export interface ServerSnapshot {
  observations: Record<string, Pick<PatrolObservation, 'note' | 'risk' | 'time'>>;
  points: Record<string, Pick<TrackPoint, 'latitude' | 'longitude' | 'at' | 'source'>>;
  samples: Record<string, Pick<Sample, 'code' | 'species' | 'count' | 'pointId'>>;
}

export interface PatrolState {
  role: Role;
  observations: PatrolObservation[];
  points: TrackPoint[];
  samples: Sample[];
  server: ServerSnapshot;
  syncing: boolean;
  /** 最近一次同步的结果摘要 */
  lastSync: { synced: number; failed: number; conflict: number; skipped: number } | null;
  /** 越权操作被拒绝的提示 */
  rejection: string | null;
  notice: string | null;
}
