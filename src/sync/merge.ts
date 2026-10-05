// 三向字段级合并：base（上次同步快照）vs local（离线本地）vs server（站里版本）
// 规则：
//   - 本地没动的字段 → 跟着站里的值走
//   - 只有本地改了 → 取本地
//   - 两边都改且值不同 → 字段级冲突，留两份内容等负责人确认
//   - 两边都改且值相同 → 取该值

import type { FieldConflict, PatrolObservation, RiskLevel, Sample, TrackPoint } from './types';

export interface MergeOutcome<T> {
  merged: T;
  conflicts: FieldConflict[];
}

const OBS_FIELDS: Record<string, string> = { note: '现场情况', risk: '风险等级' };
const POINT_FIELDS: Record<string, string> = { latitude: '纬度', longitude: '经度' };
const SAMPLE_FIELDS: Record<string, string> = { code: '样本编号', species: '物种', count: '数量', pointId: '关联轨迹点' };

function valuesEqual(a: unknown, b: unknown): boolean {
  return a === b;
}

function mergeFields(
  local: Record<string, unknown>,
  server: Record<string, unknown> | undefined,
  base: Record<string, unknown> | undefined,
  fields: Record<string, string>
): { merged: Record<string, unknown>; conflicts: FieldConflict[] } {
  const merged: Record<string, unknown> = { ...local };
  const conflicts: FieldConflict[] = [];
  for (const [field, label] of Object.entries(fields)) {
    const lv = local[field];
    const sv = server?.[field];
    const bv = base?.[field];
    const localChanged = !valuesEqual(lv, bv);
    const serverChanged = !valuesEqual(sv, bv);
    if (!localChanged) {
      // 本地没动 → 跟站里走
      merged[field] = sv;
    } else if (!serverChanged) {
      // 只有本地改了 → 取本地
      merged[field] = lv;
    } else if (valuesEqual(lv, sv)) {
      // 两边改到一样 → 取该值
      merged[field] = lv;
    } else {
      // 两边改到同一字段且不同 → 留两份，等负责人确认
      conflicts.push({ field, label, localValue: lv, serverValue: sv });
      merged[field] = lv;
    }
  }
  return { merged, conflicts };
}

export function mergeObservation(
  obs: PatrolObservation,
  server?: Pick<PatrolObservation, 'note' | 'risk'>
): MergeOutcome<PatrolObservation> {
  const { merged, conflicts } = mergeFields(
    { note: obs.note, risk: obs.risk },
    server ? { note: server.note, risk: server.risk } : undefined,
    obs.base ? { note: obs.base.note, risk: obs.base.risk } : undefined,
    OBS_FIELDS
  );
  return {
    merged: { ...obs, note: merged.note as string, risk: merged.risk as RiskLevel },
    conflicts,
  };
}

export function mergePoint(
  point: TrackPoint,
  server?: Pick<TrackPoint, 'latitude' | 'longitude'>
): MergeOutcome<TrackPoint> {
  const { merged, conflicts } = mergeFields(
    { latitude: point.latitude, longitude: point.longitude },
    server ? { latitude: server.latitude, longitude: server.longitude } : undefined,
    point.base ? { latitude: point.base.latitude, longitude: point.base.longitude } : undefined,
    POINT_FIELDS
  );
  return {
    merged: { ...point, latitude: merged.latitude as number, longitude: merged.longitude as number },
    conflicts,
  };
}

export function mergeSample(
  sample: Sample,
  server?: Pick<Sample, 'code' | 'species' | 'count' | 'pointId'>
): MergeOutcome<Sample> {
  const { merged, conflicts } = mergeFields(
    { code: sample.code, species: sample.species, count: sample.count, pointId: sample.pointId },
    server ? { code: server.code, species: server.species, count: server.count, pointId: server.pointId } : undefined,
    sample.base
      ? { code: sample.base.code, species: sample.base.species, count: sample.base.count, pointId: sample.base.pointId }
      : undefined,
    SAMPLE_FIELDS
  );
  return {
    merged: {
      ...sample,
      code: merged.code as string,
      species: merged.species as string,
      count: merged.count as number,
      pointId: merged.pointId as string | undefined,
    },
    conflicts,
  };
}

/** 负责人确认字段冲突后，按选择取值 */
export function applyFieldResolution<T extends PatrolObservation | TrackPoint | Sample>(
  record: T,
  field: string,
  choice: 'local' | 'server'
): T {
  const conflict = record.conflicts?.find((c) => c.field === field);
  if (!conflict) return record;
  const value = choice === 'local' ? conflict.localValue : conflict.serverValue;
  const next = { ...record, [field]: value } as T;
  next.conflicts = (record.conflicts ?? []).filter((c) => c.field !== field);
  return next;
}
