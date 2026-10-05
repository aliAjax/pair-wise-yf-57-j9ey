import { configureStore, createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import Taro from '@tarojs/taro';
import { applyFieldResolution } from '../sync/merge';
import { countSynced, delay, planSync, recomputeVerification, type SyncKind } from '../sync/engine';
import type {
  FieldConflict,
  PatrolState,
  PatrolObservation,
  RiskLevel,
  Role,
  Sample,
  SampleStatus,
  ServerSnapshot,
  TrackPoint,
} from '../sync/types';

const STORAGE_KEY = 'yf57-patrol-state';

const seedServer: ServerSnapshot = {
  observations: {
    o1: { note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', time: '2026-09-29 07:20' },
    o2: { note: '红外相机外壳松动', risk: 'high', time: '2026-09-29 08:05' },
    o3: { note: '样线南段没有异常', risk: 'low', time: '2026-09-29 08:40' },
    o4: { note: '样线北段发现兽径', risk: 'medium', time: '2026-09-29 09:10' },
  },
  points: {
    p1: { latitude: 30.5821, longitude: 103.2174, at: '07:20', source: 'gps' },
    p2: { latitude: 30.5856, longitude: 103.2211, at: '08:05', source: 'gps' },
  },
  samples: {
    s1: { code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, pointId: 'p1' },
  },
};

const seed: PatrolState = {
  role: 'ranger',
  observations: [
    { id: 'o1', time: '2026-09-29 07:20', note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', sync: 'synced', reviewed: false, base: { note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium' } },
    { id: 'o2', time: '2026-09-29 08:05', note: '红外相机外壳松动，已拍照待补报，位置在松林坡', risk: 'high', sync: 'queued', reviewed: false, base: { note: '红外相机外壳松动', risk: 'high' } },
    { id: 'o3', time: '2026-09-29 08:40', note: '样线南段没有异常', risk: 'low', sync: 'synced', reviewed: true, base: { note: '样线南段没有异常', risk: 'low' } },
    { id: 'o4', time: '2026-09-29 09:10', note: '样线北段发现兽径', risk: 'high', sync: 'queued', reviewed: false, base: { note: '样线北段发现兽径', risk: 'low' } },
  ],
  points: [
    { id: 'p1', latitude: 30.5821, longitude: 103.2174, at: '07:20', source: 'gps', sync: 'synced', base: { latitude: 30.5821, longitude: 103.2174 } },
    { id: 'p2', latitude: 30.5856, longitude: 103.2211, at: '08:05', source: 'gps', sync: 'synced', base: { latitude: 30.5856, longitude: 103.2211 } },
  ],
  samples: [
    { id: 's1', code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, status: 'submitted', pointId: 'p1', sync: 'synced', reviewed: false, verification: null, base: { code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, pointId: 'p1' } },
  ],
  server: seedServer,
  syncing: false,
  lastSync: null,
  rejection: null,
  notice: null,
};

function readState(): PatrolState {
  try {
    const saved = Taro.getStorageSync(STORAGE_KEY);
    if (saved) return JSON.parse(saved) as PatrolState;
  } catch {
    /* ignore */
  }
  return seed;
}

/** 负责人权限校验：巡护员越权复核/核验一律拒绝 */
function requireManager(state: PatrolState): boolean {
  if (state.role !== 'manager') {
    state.rejection = '越权操作已拒绝：仅负责人可复核观察、核验样本。';
    return false;
  }
  return true;
}

function upsertServer(state: PatrolState, kind: SyncKind, record: PatrolObservation | TrackPoint | Sample) {
  if (kind === 'observation') {
    const r = record as PatrolObservation;
    state.server.observations[r.id] = { note: r.note, risk: r.risk, time: r.time };
  } else if (kind === 'point') {
    const r = record as TrackPoint;
    state.server.points[r.id] = { latitude: r.latitude, longitude: r.longitude, at: r.at, source: r.source };
  } else {
    const r = record as Sample;
    state.server.samples[r.id] = { code: r.code, species: r.species, count: r.count, pointId: r.pointId };
  }
}

function setSynced(state: PatrolState, kind: SyncKind, record: PatrolObservation | TrackPoint | Sample) {
  if (kind === 'observation') {
    const r = state.observations.find((o) => o.id === record.id);
    if (r) {
      r.note = (record as PatrolObservation).note;
      r.risk = (record as PatrolObservation).risk;
      r.sync = 'synced';
      r.conflicts = [];
      r.base = { note: r.note, risk: r.risk };
      upsertServer(state, kind, r);
    }
  } else if (kind === 'point') {
    const r = state.points.find((p) => p.id === record.id);
    if (r) {
      r.latitude = (record as TrackPoint).latitude;
      r.longitude = (record as TrackPoint).longitude;
      r.sync = 'synced';
      r.base = { latitude: r.latitude, longitude: r.longitude };
      upsertServer(state, kind, r);
    }
  } else {
    const r = state.samples.find((s) => s.id === record.id);
    if (r) {
      r.code = (record as Sample).code;
      r.species = (record as Sample).species;
      r.count = (record as Sample).count;
      r.pointId = (record as Sample).pointId;
      r.sync = 'synced';
      r.base = { code: r.code, species: r.species, count: r.count, pointId: r.pointId };
      upsertServer(state, kind, r);
    }
  }
}

export const syncPending = createAsyncThunk<
  { synced: number; failed: number; conflict: number; skipped: number },
  void,
  { state: { patrol: PatrolState } }
>('patrol/syncPending', async (_args, { dispatch, getState }) => {
  const startState = getState().patrol;
  const planned = planSync(startState);
  const skipped = countSynced(startState);
  let synced = 0;
  let failed = 0;
  let conflict = 0;

  for (const item of planned) {
    dispatch(recordSyncStart({ kind: item.kind, id: item.id }));
    await delay(350);
    if (item.failed) {
      dispatch(recordFailed({ kind: item.kind, id: item.id }));
      failed += 1;
    } else if (item.conflicts.length > 0) {
      dispatch(recordConflict({ kind: item.kind, id: item.id, conflicts: item.conflicts }));
      conflict += 1;
    } else {
      dispatch(recordSynced({ kind: item.kind, record: item.merged }));
      synced += 1;
    }
  }
  return { synced, failed, conflict, skipped };
});

const slice = createSlice({
  name: 'patrol',
  initialState: readState(),
  reducers: {
    setRole: (state, action: PayloadAction<Role>) => {
      state.role = action.payload;
      state.rejection = null;
    },
    addObservation: (state, action: PayloadAction<{ note: string; risk: RiskLevel }>) => {
      state.observations.unshift({
        id: `o-${Date.now()}`,
        time: new Date().toLocaleString(),
        note: action.payload.note,
        risk: action.payload.risk,
        sync: 'queued',
        reviewed: false,
      });
      state.notice = '观察记录已离线保存，联网后同步。';
    },
    addPoint: (state, action: PayloadAction<{ latitude: number; longitude: number }>) => {
      state.points.push({
        id: `p-${Date.now()}`,
        latitude: action.payload.latitude,
        longitude: action.payload.longitude,
        at: new Date().toLocaleTimeString(),
        source: 'gps',
        sync: 'queued',
      });
      state.notice = '轨迹点已离线保存，联网后同步。';
    },
    addSample: (state, action: PayloadAction<{ code: string; species: string; count: number; pointId?: string }>) => {
      state.samples.unshift({
        id: `s-${Date.now()}`,
        code: action.payload.code,
        species: action.payload.species,
        count: action.payload.count,
        pointId: action.payload.pointId,
        status: 'draft',
        sync: 'queued',
        reviewed: false,
        verification: null,
      });
      state.notice = '样本已离线保存，联网后同步。';
    },
    updatePoint: (state, action: PayloadAction<{ id: string; latitude: number; longitude: number }>) => {
      const point = state.points.find((p) => p.id === action.payload.id);
      if (!point) return;
      const coordsChanged = point.latitude !== action.payload.latitude || point.longitude !== action.payload.longitude;
      point.latitude = action.payload.latitude;
      point.longitude = action.payload.longitude;
      point.sync = 'queued';
      if (coordsChanged) {
        // 坐标一变，样本核验结论作废、负责人复核重新确认
        for (const sample of state.samples) {
          if (sample.pointId === point.id) {
            sample.verification = null;
            sample.reviewed = false;
            if (sample.status === 'verified') sample.status = 'submitted';
          }
        }
        state.notice = '轨迹点坐标已变更，关联样本核验结论作废，需重新核验与复核。';
      }
    },
    recordSyncStart: (state, action: PayloadAction<{ kind: SyncKind; id: string }>) => {
      const { kind, id } = action.payload;
      if (kind === 'observation') {
        const r = state.observations.find((o) => o.id === id);
        if (r) r.sync = 'uploading';
      } else if (kind === 'point') {
        const r = state.points.find((p) => p.id === id);
        if (r) r.sync = 'uploading';
      } else {
        const r = state.samples.find((s) => s.id === id);
        if (r) r.sync = 'uploading';
      }
    },
    recordSynced: (state, action: PayloadAction<{ kind: SyncKind; record: PatrolObservation | TrackPoint | Sample }>) => {
      setSynced(state, action.payload.kind, action.payload.record);
    },
    recordFailed: (state, action: PayloadAction<{ kind: SyncKind; id: string }>) => {
      const { kind, id } = action.payload;
      if (kind === 'observation') {
        const r = state.observations.find((o) => o.id === id);
        if (r) {
          r.sync = 'failed';
          r.attempts = (r.attempts ?? 0) + 1;
        }
      } else if (kind === 'point') {
        const r = state.points.find((p) => p.id === id);
        if (r) {
          r.sync = 'failed';
          r.attempts = (r.attempts ?? 0) + 1;
        }
      } else {
        const r = state.samples.find((s) => s.id === id);
        if (r) {
          r.sync = 'failed';
          r.attempts = (r.attempts ?? 0) + 1;
        }
      }
    },
    recordConflict: (state, action: PayloadAction<{ kind: SyncKind; id: string; conflicts: FieldConflict[] }>) => {
      const { kind, id, conflicts } = action.payload;
      if (kind === 'observation') {
        const r = state.observations.find((o) => o.id === id);
        if (r) {
          r.sync = 'conflict';
          r.conflicts = conflicts;
        }
      } else if (kind === 'point') {
        const r = state.points.find((p) => p.id === id);
        if (r) {
          r.sync = 'conflict';
          r.conflicts = conflicts;
        }
      } else {
        const r = state.samples.find((s) => s.id === id);
        if (r) {
          r.sync = 'conflict';
          r.conflicts = conflicts;
        }
      }
    },
    resolveField: (state, action: PayloadAction<{ kind: SyncKind; id: string; field: string; choice: 'local' | 'server' }>) => {
      if (!requireManager(state)) return;
      const { kind, id, field, choice } = action.payload;
      if (kind === 'observation') {
        const r = state.observations.find((o) => o.id === id);
        if (!r) return;
        const next = applyFieldResolution(r, field, choice);
        r.note = next.note;
        r.risk = next.risk;
        r.conflicts = next.conflicts;
        if ((r.conflicts ?? []).length === 0) {
          r.sync = 'synced';
          r.base = { note: r.note, risk: r.risk };
          upsertServer(state, 'observation', r);
          state.notice = '字段冲突已确认，记录已同步。';
        }
      } else if (kind === 'point') {
        const r = state.points.find((p) => p.id === id);
        if (!r) return;
        const next = applyFieldResolution(r, field, choice);
        r.latitude = next.latitude;
        r.longitude = next.longitude;
        r.conflicts = next.conflicts;
        if ((r.conflicts ?? []).length === 0) {
          r.sync = 'synced';
          r.base = { latitude: r.latitude, longitude: r.longitude };
          upsertServer(state, 'point', r);
          state.notice = '字段冲突已确认，轨迹点已同步。';
        }
      } else {
        const r = state.samples.find((s) => s.id === id);
        if (!r) return;
        const next = applyFieldResolution(r, field, choice);
        r.code = next.code;
        r.species = next.species;
        r.count = next.count;
        r.pointId = next.pointId;
        r.conflicts = next.conflicts;
        if ((r.conflicts ?? []).length === 0) {
          r.sync = 'synced';
          r.base = { code: r.code, species: r.species, count: r.count, pointId: r.pointId };
          upsertServer(state, 'sample', r);
          state.notice = '字段冲突已确认，样本已同步。';
        }
      }
    },
    reviewObservation: (state, action: PayloadAction<string>) => {
      if (!requireManager(state)) return;
      const item = state.observations.find((o) => o.id === action.payload);
      if (item) item.reviewed = true;
    },
    verifySample: (state, action: PayloadAction<string>) => {
      if (!requireManager(state)) return;
      const item = state.samples.find((s) => s.id === action.payload);
      if (item) {
        item.verification = recomputeVerification(item, state.points);
        item.status = 'verified';
      }
    },
    reviewSample: (state, action: PayloadAction<string>) => {
      if (!requireManager(state)) return;
      const item = state.samples.find((s) => s.id === action.payload);
      if (item) item.reviewed = true;
    },
    clearRejection: (state) => {
      state.rejection = null;
    },
    clearNotice: (state) => {
      state.notice = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(syncPending.pending, (state) => {
        state.syncing = true;
        state.rejection = null;
      })
      .addCase(syncPending.fulfilled, (state, action) => {
        state.syncing = false;
        state.lastSync = action.payload;
        const { synced, failed, conflict, skipped } = action.payload;
        state.notice = `同步完成：新传 ${synced} 条，失败 ${failed} 条（仅重试未传完记录），冲突 ${conflict} 条待负责人确认，已同步跳过 ${skipped} 条（不重复上传）。`;
      })
      .addCase(syncPending.rejected, (state) => {
        state.syncing = false;
        state.notice = '同步中断，已传记录保留 synced 状态，下次仅重试未传完记录。';
      });
  },
});

export const patrolApi = createApi({
  reducerPath: 'patrolApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    connection: builder.query<{ online: boolean }, void>({ queryFn: () => ({ data: { online: true } }) }),
  }),
});
export const { useConnectionQuery } = patrolApi;

export const {
  setRole,
  addObservation,
  addPoint,
  addSample,
  updatePoint,
  recordSyncStart,
  recordSynced,
  recordFailed,
  recordConflict,
  resolveField,
  reviewObservation,
  verifySample,
  reviewSample,
  clearRejection,
  clearNotice,
} = slice.actions;

export const store = configureStore({
  reducer: { patrol: slice.reducer, [patrolApi.reducerPath]: patrolApi.reducer },
  middleware: (getDefault) => getDefault().concat(patrolApi.middleware),
});

if (typeof window !== 'undefined') {
  store.subscribe(() => {
    const state = store.getState().patrol;
    Taro.setStorageSync(STORAGE_KEY, JSON.stringify(state));
  });
}

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
export type { SampleStatus };
