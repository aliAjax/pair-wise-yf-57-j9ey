import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import Taro from '@tarojs/taro';
import type {
  AppState,
  FieldConflict,
  ObservationDoc,
  PointDoc,
  Risk,
  Role,
  SampleDoc,
  StationObservation,
  StationState
} from '../types';
import {
  loadStation,
  recomputeVerifyNote,
  saveStation,
  stationCorrectPoint,
  stationEditObservation,
  stationEditSample,
  stationReviewObservation,
  stationVerifySample,
  uploadObservation,
  uploadPoint,
  uploadSample
} from '../station';
import { seedApp, seedStation } from '../seed';

const STATE_KEY = 'yf57-patrol-state-v2';

function loadApp(): AppState {
  try {
    const saved = Taro.getStorageSync(STATE_KEY);
    if (saved) return JSON.parse(saved) as AppState;
  } catch {
    /* 旧版本数据不兼容时回退种子 */
  }
  return seedApp();
}

// ---- 字段级三向合并：local 本地改后的值，remote 站里当前值，base 上次同步基线 ----
// 返回 conflict 表示两边改了同一字段且不一致；否则给出合并后的值。
function mergeField(
  field: string,
  local: string,
  remote: string,
  base: string | null,
  conflicts: Record<string, FieldConflict>
): string {
  const localChanged = base === null ? true : local !== base;
  const remoteChanged = base === null ? false : remote !== base;
  if (localChanged && remoteChanged && local !== remote) {
    conflicts[field] = { local, remote };
    return local; // 两份都保留到 conflicts，临时值不影响展示，等负责人裁决
  }
  // 只有站里改、本地没动：跟站里值走；本地改、站里没动：用本地
  return remoteChanged ? remote : local;
}

interface MergeResult {
  conflicts: Record<string, FieldConflict>;
}

function mergeObservation(doc: ObservationDoc, remote: StationObservation): MergeResult {
  const conflicts: Record<string, FieldConflict> = {};
  doc.note = mergeField('note', doc.note, remote.note, doc.base?.note ?? null, conflicts);
  doc.risk = mergeField('risk', doc.risk, remote.risk, doc.base?.risk ?? null, conflicts) as Risk;
  // 复核是负责人域：无论本地是否标记，一律跟站里值走，巡护员离线不能伪造复核
  doc.reviewed = remote.reviewed;
  return { conflicts };
}

function mergePoint(doc: PointDoc, remote: StationPointShape): MergeResult {
  const conflicts: Record<string, FieldConflict> = {};
  doc.latitude = Number(
    mergeField('latitude', String(doc.latitude), String(remote.latitude), doc.base ? String(doc.base.latitude) : null, conflicts)
  );
  doc.longitude = Number(
    mergeField('longitude', String(doc.longitude), String(remote.longitude), doc.base ? String(doc.base.longitude) : null, conflicts)
  );
  return { conflicts };
}

type StationPointShape = StationState['points'][number];

function mergeSample(doc: SampleDoc, remote: StationState['samples'][number]): MergeResult {
  const conflicts: Record<string, FieldConflict> = {};
  doc.code = mergeField('code', doc.code, remote.code, doc.base?.code ?? null, conflicts);
  doc.species = mergeField('species', doc.species, remote.species, doc.base?.species ?? null, conflicts);
  doc.count = Number(mergeField('count', String(doc.count), String(remote.count), doc.base ? String(doc.base.count) : null, conflicts));
  // 核验结论 / 状态 / 坐标版本都是负责人域（含坐标级联作废），跟站里值走
  doc.status = remote.status;
  doc.verifyNote = remote.verifyNote;
  doc.verifiedBy = remote.verifiedBy;
  doc.coordVersion = remote.coordVersion;
  return { conflicts };
}

// 合并完成且无冲突：推进基线、清脏标记，这条记录与站里一致
function settleObservation(doc: ObservationDoc) {
  doc.base = { note: doc.note, risk: doc.risk };
  doc.dirtyFields = [];
  doc.conflicts = {};
  doc.sync = 'synced';
}

function settlePoint(doc: PointDoc) {
  doc.base = { latitude: doc.latitude, longitude: doc.longitude };
  doc.dirtyFields = [];
  doc.conflicts = {};
  doc.sync = 'synced';
}

function settleSample(doc: SampleDoc) {
  doc.base = { code: doc.code, species: doc.species, count: doc.count };
  doc.dirtyFields = [];
  doc.conflicts = {};
  doc.sync = 'synced';
}

// 坐标版本递增后，本地把依赖该轨迹点的样本/观察同步级联作废
function bumpLocalCoordinate(state: AppState, pointId: string) {
  const point = state.points.find((item) => item.clientId === pointId);
  if (!point) return;
  state.samples.forEach((sample) => {
    if (sample.pointId !== pointId) return;
    sample.status = 'submitted';
    sample.verifiedBy = '';
    sample.coordVersion = point.coordVersion;
    sample.verifyNote = recomputeVerifyNote(point);
    if (sample.base) {
      // 已在站里的记录需要重新上传作废结果，等站里级联后再与站里一致
      sample.sync = 'queued';
      sample.conflicts = {};
    }
  });
  state.observations.forEach((obs) => {
    if (obs.pointId === pointId && obs.base) obs.reviewed = false;
  });
}

interface SyncTask {
  kind: 'observation' | 'point' | 'sample';
  clientId: string;
}

function pendingTasks(state: AppState): SyncTask[] {
  const tasks: SyncTask[] = [];
  // 观察 → 轨迹 → 样本，保证样本上传时其关联轨迹点已在站里（坐标版本才准）
  state.observations.forEach((doc) => {
    if (doc.sync === 'queued' || doc.sync === 'failed') tasks.push({ kind: 'observation', clientId: doc.clientId });
  });
  state.points.forEach((doc) => {
    if (doc.sync === 'queued' || doc.sync === 'failed') tasks.push({ kind: 'point', clientId: doc.clientId });
  });
  state.samples.forEach((doc) => {
    if (doc.sync === 'queued' || doc.sync === 'failed') tasks.push({ kind: 'sample', clientId: doc.clientId });
  });
  return tasks;
}

let station: StationState = loadStation(seedStation());

const slice = createSlice({
  name: 'patrol',
  initialState: loadApp(),
  reducers: {
    switchRole: (state, action: PayloadAction<Role>) => {
      state.role = action.payload;
      state.notice = action.payload === 'manager' ? '已切换为站点负责人，拥有复核/核验/冲突裁决权限。' : '当前身份：巡护员，只能记录与提交，复核会被拒绝。';
    },
    toggleOnline: (state) => {
      state.online = !state.online;
      state.notice = state.online ? '已恢复联网。' : '已进入无信号区，所有记录只写本地队列。';
    },
    toggleFailInjection: (state) => {
      state.failNextMidSync = !state.failNextMidSync;
      state.notice = state.failNextMidSync ? '下次同步将在第一条传完后断连（演示中途失败）。' : '已取消中途失败模拟。';
    },
    dismissNotice: (state) => {
      state.notice = null;
    },

    // 巡护员：离线新增观察
    addObservation: (state, action: PayloadAction<{ note: string; risk: Risk }>) => {
      const latest = state.points[state.points.length - 1];
      state.observations.push({
        kind: 'observation',
        clientId: `o-${Date.now()}`,
        time: new Date().toLocaleString(),
        note: action.payload.note,
        risk: action.payload.risk,
        sync: 'queued',
        conflicts: {},
        dirtyFields: ['note', 'risk'],
        reviewed: false,
        pointId: latest ? latest.clientId : null,
        base: null
      });
      state.notice = '已存入本地队列，回网后逐条合并。';
    },

    // 巡护员：记录当前轨迹点（无信号时拿不到定位也允许手填落点）
    addPoint: (state, action: PayloadAction<{ latitude: number; longitude: number }>) => {
      state.points.push({
        kind: 'point',
        clientId: `p-${Date.now()}`,
        latitude: action.payload.latitude,
        longitude: action.payload.longitude,
        at: new Date().toLocaleTimeString(),
        source: 'gps',
        sync: 'queued',
        conflicts: {},
        dirtyFields: ['latitude', 'longitude'],
        coordVersion: 1,
        base: null
      });
    },

    // 巡护员：提交样本（挂在最近轨迹点上）
    addSample: (state, action: PayloadAction<{ code: string; species: string; count: number }>) => {
      const latest = state.points[state.points.length - 1];
      state.samples.push({
        kind: 'sample',
        clientId: `s-${Date.now()}`,
        code: action.payload.code,
        species: action.payload.species,
        count: action.payload.count,
        pointId: latest ? latest.clientId : '',
        sync: 'queued',
        conflicts: {},
        dirtyFields: ['code', 'species', 'count'],
        status: 'submitted',
        verifyNote: '已提交，待负责人核验',
        verifiedBy: '',
        coordVersion: latest ? latest.coordVersion : 1,
        base: null
      });
      state.notice = '样本已进入本地队列。';
    },

    // 巡护员：离线修改自己记录的字段（note/risk）
    editObservationOffline: (
      state,
      action: PayloadAction<{ clientId: string; note?: string; risk?: Risk }>
    ) => {
      if (state.role !== 'ranger') {
        state.notice = '只有巡护员本人编辑现场记录；负责人请在站里端修改。';
        return;
      }
      const doc = state.observations.find((item) => item.clientId === action.payload.clientId);
      if (!doc) return;
      if (action.payload.note !== undefined && action.payload.note !== doc.note) {
        doc.note = action.payload.note;
        if (!doc.dirtyFields.includes('note')) doc.dirtyFields.push('note');
      }
      if (action.payload.risk !== undefined && action.payload.risk !== doc.risk) {
        doc.risk = action.payload.risk;
        if (!doc.dirtyFields.includes('risk')) doc.dirtyFields.push('risk');
      }
      if (doc.sync === 'synced') doc.sync = 'queued';
      state.notice = '离线改动已标记，回网合并时按字段比对。';
    },

    // 负责人：在本地（设备）修正轨迹点坐标 → 坐标版本+1并级联作废
    correctPointLocal: (
      state,
      action: PayloadAction<{ clientId: string; latitude: number; longitude: number }>
    ) => {
      if (state.role !== 'manager') {
        state.notice = '越权拒绝：只有站点负责人能修正轨迹点坐标。';
        return;
      }
      const point = state.points.find((item) => item.clientId === action.payload.clientId);
      if (!point) return;
      if (point.latitude === action.payload.latitude && point.longitude === action.payload.longitude) {
        state.notice = '坐标没有变化，无需重算。';
        return;
      }
      point.latitude = action.payload.latitude;
      point.longitude = action.payload.longitude;
      point.coordVersion += 1;
      if (point.base) {
        point.sync = 'queued'; // 已同步过：重新上传，站里收到坐标变化后级联
        point.conflicts = {};
        if (!point.dirtyFields.includes('latitude')) point.dirtyFields.push('latitude');
        if (!point.dirtyFields.includes('longitude')) point.dirtyFields.push('longitude');
      }
      bumpLocalCoordinate(state, point.clientId);
      state.notice = '坐标已变更：依赖该点的样本核验结论作废并按新坐标重算，关联观察需负责人重新复核。同步回站里后同样级联。';
    },

    // 负责人复核观察
    reviewObservation: (state, action: PayloadAction<string>) => {
      if (state.role !== 'manager') {
        state.notice = '越权拒绝：复核由站点负责人执行，巡护员的复核操作不生效。';
        return;
      }
      const doc = state.observations.find((item) => item.clientId === action.payload);
      if (!doc) return;
      if (doc.sync === 'conflict') {
        state.notice = '该记录字段还有冲突未裁决，裁决后才能复核。';
        return;
      }
      doc.reviewed = true;
      if (doc.base) stationReviewObservation(station, doc.clientId);
      state.notice = '复核完成，已写回站里。';
    },

    // 负责人核验样本
    verifySample: (state, action: PayloadAction<string>) => {
      if (state.role !== 'manager') {
        state.notice = '越权拒绝：样本核验由站点负责人执行，巡护员的核验操作不生效且不留记录。';
        return;
      }
      const doc = state.samples.find((item) => item.clientId === action.payload);
      if (!doc) return;
      if (doc.sync === 'conflict') {
        state.notice = '该样本字段还有冲突未裁决，裁决后才能核验。';
        return;
      }
      doc.status = 'verified';
      doc.verifiedBy = '负责人·周岚';
      doc.verifyNote = `核验通过：确认坐标版本 v${doc.coordVersion} 下证据有效`;
      if (doc.base) stationVerifySample(station, doc.clientId, doc.verifiedBy);
      state.notice = '样本核验完成，已写回站里。';
    },

    // 负责人对一个冲突字段裁决：取本地巡护员版本 or 站里版本
    resolveField: (
      state,
      action: PayloadAction<{ kind: 'observation' | 'point' | 'sample'; clientId: string; field: string; choice: 'local' | 'remote' }>
    ) => {
      if (state.role !== 'manager') {
        state.notice = '越权拒绝：冲突裁决只能由站点负责人确认。';
        return;
      }
      const { kind, clientId, field, choice } = action.payload;
      const collection =
        kind === 'observation' ? state.observations : kind === 'point' ? state.points : state.samples;
      const doc = collection.find((item) => item.clientId === clientId) as
        | ObservationDoc
        | PointDoc
        | SampleDoc
        | undefined;
      if (!doc) return;
      const conflict = doc.conflicts[field];
      if (!conflict) return;
      const chosen = choice === 'local' ? conflict.local : conflict.remote;
      if (kind === 'observation') {
        const obs = doc as ObservationDoc;
        if (field === 'note') obs.note = chosen;
        if (field === 'risk') obs.risk = chosen as Risk;
      } else if (kind === 'point') {
        const point = doc as PointDoc;
        const num = Number(chosen);
        if (field === 'latitude') point.latitude = num;
        if (field === 'longitude') point.longitude = num;
      } else {
        const sample = doc as SampleDoc;
        if (field === 'code') sample.code = chosen;
        if (field === 'species') sample.species = chosen;
        if (field === 'count') sample.count = Number(chosen);
      }
      delete doc.conflicts[field];

      // 所有冲突字段都裁决完：用最终合并结果回写站里并落为已同步
      if (Object.keys(doc.conflicts).length === 0) {
        if (kind === 'observation') {
          const obs = doc as ObservationDoc;
          const remote = station.observations.find((item) => item.clientId === obs.clientId);
          uploadObservation(station, {
            clientId: obs.clientId,
            time: obs.time,
            note: obs.note,
            risk: obs.risk,
            reviewed: remote ? remote.reviewed : obs.reviewed,
            pointId: obs.pointId
          });
          settleObservation(obs);
        } else if (kind === 'point') {
          const point = doc as PointDoc;
          uploadPoint(station, {
            clientId: point.clientId,
            latitude: point.latitude,
            longitude: point.longitude,
            at: point.at,
            source: point.source,
            coordVersion: point.coordVersion
          });
          // 站里若因坐标变化级联，把作废结果拉回本地
          const remotePoint = station.points.find((item) => item.clientId === point.clientId);
          if (remotePoint) {
            point.coordVersion = remotePoint.coordVersion;
            state.samples.forEach((sample) => {
              if (sample.pointId !== point.clientId) return;
              const rs = station.samples.find((item) => item.clientId === sample.clientId);
              if (rs) {
                sample.status = rs.status;
                sample.verifyNote = rs.verifyNote;
                sample.verifiedBy = rs.verifiedBy;
                sample.coordVersion = rs.coordVersion;
              }
            });
            state.observations.forEach((obs) => {
              if (obs.pointId !== point.clientId) return;
              const ro = station.observations.find((item) => item.clientId === obs.clientId);
              if (ro) obs.reviewed = ro.reviewed;
            });
          }
          settlePoint(point);
        } else {
          const sample = doc as SampleDoc;
          uploadSample(station, {
            clientId: sample.clientId,
            code: sample.code,
            species: sample.species,
            count: sample.count,
            pointId: sample.pointId,
            status: sample.status,
            verifyNote: sample.verifyNote,
            verifiedBy: sample.verifiedBy,
            coordVersion: sample.coordVersion
          });
          settleSample(sample);
        }
        saveStation(station);
        state.notice = `冲突已按${choice === 'local' ? '巡护员现场版本' : '站里版本'}确认并写回站里。`;
        state.lastSyncReport = '冲突记录已合并完成，站里只保存最终的一份。';
      } else {
        state.notice = '该字段已确认，还有其他冲突字段等待裁决。';
      }
    },

    // 核心动作：上传阶段逐条传 queued/failed 并与站里字段级合并；
    // 拉取阶段只处理已 synced 的记录，把站里单方面的更新取回（只拉不传，故不会重复）。
    runSync: (state) => {
      if (!state.online) {
        state.notice = '当前无信号，无法同步；记录已安全保存在本地。';
        return;
      }
      const tasks = pendingTasks(state);

      // 多条任务且开启失败注入时，只让第一条传成功，随后断连：
      // 成功的不会重传，剩下的标记 failed，下次只重试这些。
      const injectFailure = state.failNextMidSync && tasks.length > 1;
      state.failNextMidSync = false;
      const failAfter = injectFailure ? 1 : tasks.length + 1;

      const done: string[] = [];
      const failed: string[] = [];
      const conflicted: string[] = [];
      let interrupted = false;

      // ---- 阶段一：上传本地未完成的记录 ----
      for (let index = 0; index < tasks.length; index += 1) {
        if (index >= failAfter) {
          // 断连：还没轮到的全部留在 failed（含本次没开始的）
          tasks.slice(index).forEach((task) => {
            const doc =
              task.kind === 'observation'
                ? state.observations.find((item) => item.clientId === task.clientId)
                : task.kind === 'point'
                  ? state.points.find((item) => item.clientId === task.clientId)
                  : state.samples.find((item) => item.clientId === task.clientId);
            if (doc) doc.sync = 'failed';
            failed.push(`${task.kind}:${task.clientId}`);
          });
          interrupted = true;
          break;
        }

        const task = tasks[index];
        if (task.kind === 'observation') {
          const doc = state.observations.find((item) => item.clientId === task.clientId);
          if (!doc) continue;
          const remote = station.observations.find((item) => item.clientId === doc.clientId);
          if (remote) {
            const { conflicts } = mergeObservation(doc, remote);
            if (Object.keys(conflicts).length > 0) {
              doc.sync = 'conflict';
              doc.conflicts = conflicts;
              conflicted.push(doc.clientId);
              continue;
            }
            // 无冲突：本地胜出的字段（仅本地改过）随合并回写站里；只跟站里走的复核域用 remote
            uploadObservation(station, {
              clientId: doc.clientId,
              time: doc.time,
              note: doc.note,
              risk: doc.risk,
              reviewed: remote.reviewed,
              pointId: doc.pointId
            });
          } else {
            uploadObservation(station, {
              clientId: doc.clientId,
              time: doc.time,
              note: doc.note,
              risk: doc.risk,
              reviewed: doc.reviewed,
              pointId: doc.pointId
            });
          }
          settleObservation(doc);
          done.push(`观察 ${doc.clientId}`);
        } else if (task.kind === 'point') {
          const doc = state.points.find((item) => item.clientId === task.clientId);
          if (!doc) continue;
          const remote = station.points.find((item) => item.clientId === doc.clientId);
          if (remote) {
            const { conflicts } = mergePoint(doc, remote);
            if (Object.keys(conflicts).length > 0) {
              doc.sync = 'conflict';
              doc.conflicts = conflicts;
              conflicted.push(doc.clientId);
              continue;
            }
            uploadPoint(station, {
              clientId: doc.clientId,
              latitude: doc.latitude,
              longitude: doc.longitude,
              at: doc.at,
              source: doc.source,
              coordVersion: doc.coordVersion
            });
          } else {
            uploadPoint(station, {
              clientId: doc.clientId,
              latitude: doc.latitude,
              longitude: doc.longitude,
              at: doc.at,
              source: doc.source,
              coordVersion: doc.coordVersion
            });
          }
          // 站里若因坐标变化级联，把作废结果与最终坐标版本拉回本地
          const remotePoint = station.points.find((item) => item.clientId === doc.clientId)!;
          doc.latitude = remotePoint.latitude;
          doc.longitude = remotePoint.longitude;
          doc.coordVersion = remotePoint.coordVersion;
          state.samples.forEach((sample) => {
            if (sample.pointId !== doc.clientId) return;
            const rs = station.samples.find((item) => item.clientId === sample.clientId);
            if (rs) {
              sample.status = rs.status;
              sample.verifyNote = rs.verifyNote;
              sample.verifiedBy = rs.verifiedBy;
              sample.coordVersion = rs.coordVersion;
            } else {
              sample.status = 'submitted';
              sample.verifyNote = recomputeVerifyNote(remotePoint);
              sample.verifiedBy = '';
              sample.coordVersion = remotePoint.coordVersion;
            }
          });
          state.observations.forEach((obs) => {
            if (obs.pointId !== doc.clientId) return;
            const ro = station.observations.find((item) => item.clientId === obs.clientId);
            if (ro) obs.reviewed = ro.reviewed;
            else if (obs.base) obs.reviewed = false;
          });
          settlePoint(doc);
          done.push(`轨迹点 ${doc.clientId}`);
        } else {
          const doc = state.samples.find((item) => item.clientId === task.clientId);
          if (!doc) continue;
          const remote = station.samples.find((item) => item.clientId === doc.clientId);
          if (remote) {
            const { conflicts } = mergeSample(doc, remote);
            if (Object.keys(conflicts).length > 0) {
              doc.sync = 'conflict';
              doc.conflicts = conflicts;
              conflicted.push(doc.clientId);
              continue;
            }
            uploadSample(station, {
              clientId: doc.clientId,
              code: doc.code,
              species: doc.species,
              count: doc.count,
              pointId: doc.pointId,
              status: remote.status,
              verifyNote: remote.verifyNote,
              verifiedBy: remote.verifiedBy,
              coordVersion: remote.coordVersion
            });
          } else {
            uploadSample(station, {
              clientId: doc.clientId,
              code: doc.code,
              species: doc.species,
              count: doc.count,
              pointId: doc.pointId,
              status: doc.status,
              verifyNote: doc.verifyNote,
              verifiedBy: doc.verifiedBy,
              coordVersion: doc.coordVersion
            });
          }
          const rs = station.samples.find((item) => item.clientId === doc.clientId);
          if (rs) {
            doc.status = rs.status;
            doc.verifyNote = rs.verifyNote;
            doc.verifiedBy = rs.verifiedBy;
            doc.coordVersion = rs.coordVersion;
          }
          settleSample(doc);
          done.push(`样本 ${doc.clientId}`);
        }
      }

      // ---- 阶段二：拉取站里对已同步记录的单方面更新（只拉取、绝不上传）----
      // 本地没动的字段跟站里值走；三向合并不可能在这里产生冲突（本地侧全部未改）。
      const pulled: string[] = [];
      if (!interrupted) {
        state.observations.forEach((doc) => {
          if (doc.sync !== 'synced') return;
          const remote = station.observations.find((item) => item.clientId === doc.clientId);
          if (!remote) return;
          const before = `${doc.note}|${doc.risk}|${doc.reviewed}`;
          mergeObservation(doc, remote);
          if (`${doc.note}|${doc.risk}|${doc.reviewed}` !== before) pulled.push(`观察 ${doc.clientId}`);
          settleObservation(doc);
        });
        state.points.forEach((doc) => {
          if (doc.sync !== 'synced') return;
          const remote = station.points.find((item) => item.clientId === doc.clientId);
          if (!remote) return;
          const movedHere =
            remote.latitude !== doc.latitude ||
            remote.longitude !== doc.longitude ||
            remote.coordVersion !== doc.coordVersion;
          if (!movedHere) return;
          doc.latitude = remote.latitude;
          doc.longitude = remote.longitude;
          doc.coordVersion = remote.coordVersion;
          // 坐标级联：站里改了坐标 → 本地样本核验作废重算、观察复核重置
          state.samples.forEach((sample) => {
            if (sample.pointId !== doc.clientId) return;
            const rs = station.samples.find((item) => item.clientId === sample.clientId);
            if (rs) {
              sample.status = rs.status;
              sample.verifyNote = rs.verifyNote;
              sample.verifiedBy = rs.verifiedBy;
              sample.coordVersion = rs.coordVersion;
            }
          });
          state.observations.forEach((obs) => {
            if (obs.pointId !== doc.clientId) return;
            const ro = station.observations.find((item) => item.clientId === obs.clientId);
            if (ro) obs.reviewed = ro.reviewed;
          });
          settlePoint(doc);
          pulled.push(`轨迹点 ${doc.clientId}（坐标变更已级联作废重算）`);
        });
        state.samples.forEach((doc) => {
          if (doc.sync !== 'synced') return;
          const remote = station.samples.find((item) => item.clientId === doc.clientId);
          if (!remote) return;
          const before = `${doc.code}|${doc.species}|${doc.count}|${doc.status}|${doc.verifyNote}|${doc.coordVersion}`;
          mergeSample(doc, remote);
          if (
            `${doc.code}|${doc.species}|${doc.count}|${doc.status}|${doc.verifyNote}|${doc.coordVersion}` !== before
          ) {
            pulled.push(`样本 ${doc.clientId}`);
          }
          settleSample(doc);
        });
      }

      saveStation(station);

      const lines: string[] = [];
      if (done.length > 0) lines.push(`已合并上传 ${done.length} 条：${done.join('、')}（按客户端ID幂等，不产生重复）`);
      if (pulled.length > 0) lines.push(`站里更新已拉取 ${pulled.length} 条：${pulled.join('、')}（本地没动的字段跟站里值走）`);
      if (conflicted.length > 0) lines.push(`${conflicted.length} 条存在同字段两边修改：${conflicted.join('、')}，两份内容已保留，等负责人逐条裁决。`);
      if (interrupted) lines.push(`同步中途断连，${failed.length} 条没传完：${failed.join('、')}；已传成功的不会重传，点“重试没传完的”只补传这些。`);
      state.lastSyncReport =
        lines.length > 0
          ? lines.join('\n')
          : tasks.length === 0
            ? '没有待上传记录，站里也没有新更新；已同步内容不会重复上传。'
            : '同步完成。';
      state.notice = interrupted
        ? '同步中途失败：只重试没传完的记录，已传成功的记录不会重复上传。'
        : conflicted.length > 0
          ? '同步完成，部分字段两边都改过，请负责人裁决。'
          : '同步完成，本地与站里版本一致。';
    },

    // 幂等演示：把一条已同步的观察按完全相同的内容再传一次，站里识别为 duplicate
    demonstrateDuplicate: (state) => {
      const doc = state.observations.find((item) => item.sync === 'synced');
      if (!doc) {
        state.notice = '当前没有已同步的观察可演示；先完成一次同步。';
        return;
      }
      const before = station.observations.length;
      const result = uploadObservation(station, {
        clientId: doc.clientId,
        time: doc.time,
        note: doc.note,
        risk: doc.risk,
        reviewed: doc.reviewed,
        pointId: doc.pointId
      });
      saveStation(station);
      state.notice =
        result.outcome === 'duplicate'
          ? `重复上传观察 ${doc.clientId}：内容完全相同，站里按客户端ID识别后丢弃，总数不变（${before} 条）。`
          : '该记录与站里内容有差异，已作为一次修订更新到同一份（仍不会多出一条）。';
      state.lastSyncReport = '幂等校验：同一条记录重复上传不会多出一份。';
    },

    // ---- 演示用：模拟站里端的动作 ----

    // 站里负责人改了某条观察的备注（本地完全没动）→ 同步时没动的字段跟站里值走
    simStationEditObservation: (
      state,
      action: PayloadAction<{ clientId: string; note: string; risk?: Risk }>
    ) => {
      stationEditObservation(station, action.payload.clientId, { note: action.payload.note, risk: action.payload.risk });
      saveStation(station);
      state.notice = `已模拟：站里把观察 ${action.payload.clientId} 的备注改为「${action.payload.note}」，本地尚未同步。`;
    },

    // 站里负责人改了样本名称
    simStationEditSample: (
      state,
      action: PayloadAction<{ clientId: string; species: string }>
    ) => {
      stationEditSample(station, action.payload.clientId, { species: action.payload.species });
      saveStation(station);
      state.notice = `已模拟：站里把样本 ${action.payload.clientId} 改为「${action.payload.species}」。`;
    },

    // 站里修正轨迹点坐标：版本+1，依赖样本核验作废重算、观察复核重置
    simStationCorrectPoint: (
      state,
      action: PayloadAction<{ clientId: string; latitude: number; longitude: number }>
    ) => {
      const changed = stationCorrectPoint(station, action.payload.clientId, action.payload.latitude, action.payload.longitude);
      saveStation(station);
      if (changed) {
        state.notice = `已模拟：站里把轨迹点 ${action.payload.clientId} 修正到 ${action.payload.latitude.toFixed(4)},${action.payload.longitude.toFixed(4)}，坐标版本+1；依赖该点的样本核验已作废重算、观察复核已重置。回网同步即拉取。`;
      } else {
        state.notice = '站里坐标没有变化。';
      }
    },

    // 恢复演示初始数据（站里、本地全部重置）
    resetDemo: (state) => {
      const fresh = seedApp();
      Object.assign(state, fresh);
      station = seedStation();
      saveStation(station);
      state.notice = '演示数据已重置。';
      state.lastSyncReport = null;
    }
  }
});

export const {
  switchRole,
  toggleOnline,
  toggleFailInjection,
  dismissNotice,
  addObservation,
  addPoint,
  addSample,
  editObservationOffline,
  correctPointLocal,
  reviewObservation,
  verifySample,
  resolveField,
  runSync,
  demonstrateDuplicate,
  simStationEditObservation,
  simStationEditSample,
  simStationCorrectPoint,
  resetDemo
} = slice.actions;

export const store = configureStore({ reducer: { patrol: slice.reducer } });

if (typeof window !== 'undefined') {
  store.subscribe(() => {
    try {
      Taro.setStorageSync(STATE_KEY, JSON.stringify(store.getState().patrol));
    } catch {
      /* ignore */
    }
  });
}

export type RootState = ReturnType<typeof store.getState>;
