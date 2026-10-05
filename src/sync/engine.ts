// 同步引擎：逐条合并、模拟弱网失败、坐标变动触发核验作废重算
// 幂等：已 synced 的记录不会进入上传计划，重复上传不会多出一份

import { mergeObservation, mergePoint, mergeSample } from './merge';
import type { FieldConflict, PatrolState, PatrolObservation, Sample, TrackPoint, Verification } from './types';

/** 巡护范围（用于判断样本位置是否正常） */
export const PATROL_BOUNDS = { latMin: 30.5, latMax: 30.7, lngMin: 103.1, lngMax: 103.3 };

/**
 * 模拟弱网：首次上传按 id 哈希确定性失败（约 25%），重试一定成功。
 * 这样既能演示"中途失败"，又能让"只重试没传完的记录"稳定复现。
 */
export function willUploadFail(id: string, attempts: number): boolean {
  if (attempts > 0) return false;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 4 === 0;
}

/** 由关联轨迹点坐标重算样本核验结论 */
export function recomputeVerification(sample: Sample, points: TrackPoint[]): Verification {
  const point = sample.pointId ? points.find((p) => p.id === sample.pointId) : undefined;
  const inBounds =
    !!point &&
    point.latitude >= PATROL_BOUNDS.latMin &&
    point.latitude <= PATROL_BOUNDS.latMax &&
    point.longitude >= PATROL_BOUNDS.lngMin &&
    point.longitude <= PATROL_BOUNDS.lngMax;
  return { conclusion: inBounds ? 'normal' : 'abnormal', at: new Date().toISOString() };
}

export type SyncKind = 'observation' | 'point' | 'sample';

export interface PlannedSync {
  kind: SyncKind;
  id: string;
  merged: PatrolObservation | TrackPoint | Sample;
  conflicts: FieldConflict[];
  failed: boolean;
}

/** 规划本次要上传的记录：仅 queued / failed，已 synced 与 conflict 不在此列 */
export function planSync(state: PatrolState): PlannedSync[] {
  const pending: PlannedSync[] = [];
  for (const obs of state.observations) {
    if (obs.sync !== 'queued' && obs.sync !== 'failed') continue;
    const { merged, conflicts } = mergeObservation(obs, state.server.observations[obs.id]);
    pending.push({ kind: 'observation', id: obs.id, merged, conflicts, failed: willUploadFail(obs.id, obs.attempts ?? 0) });
  }
  for (const point of state.points) {
    if (point.sync !== 'queued' && point.sync !== 'failed') continue;
    const { merged, conflicts } = mergePoint(point, state.server.points[point.id]);
    pending.push({ kind: 'point', id: point.id, merged, conflicts, failed: willUploadFail(point.id, point.attempts ?? 0) });
  }
  for (const sample of state.samples) {
    if (sample.sync !== 'queued' && sample.sync !== 'failed') continue;
    const { merged, conflicts } = mergeSample(sample, state.server.samples[sample.id]);
    pending.push({ kind: 'sample', id: sample.id, merged, conflicts, failed: willUploadFail(sample.id, sample.attempts ?? 0) });
  }
  return pending;
}

/** 统计已同步（跳过上传）的记录数 —— 幂等：重复上传不会多出一份 */
export function countSynced(state: PatrolState): number {
  return (
    state.observations.filter((o) => o.sync === 'synced').length +
    state.points.filter((p) => p.sync === 'synced').length +
    state.samples.filter((s) => s.sync === 'synced').length
  );
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
