const { createEmptyRaw } = require('./cpti_engine');

const LOCAL_STORE_KEY = 'CPTI_LOCAL_ROOMS';
const ACTIVE_ROOM_KEY = 'CPTI_ACTIVE_PAIR_ROOM';
const ROOM_TTL_MS = 24 * 60 * 60 * 1000; // 房间 24 小时有效期

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function getLocalRooms() {
  try {
    return wx.getStorageSync(LOCAL_STORE_KEY) || {};
  } catch (e) {
    return {};
  }
}

function saveLocalRooms(map) {
  try {
    wx.setStorageSync(LOCAL_STORE_KEY, map);
  } catch (e) {}
}

function serializeRaw(raw) {
  return (raw || createEmptyRaw()).map(v => (v === null || v === undefined ? 'UNASKED' : v));
}

function isRoomExpired(room) {
  if (!room || !room.createdAt) return false;
  return Date.now() - Number(room.createdAt) > ROOM_TTL_MS;
}

// 双方都退出后房间即视为作废，防止第三个人复用旧房间读到旧结果
function isRoomClosed(room) {
  if (!room) return true;
  if (room.closed) return true;
  return !!(room.exitA && room.exitB);
}

async function createRoom() {
  const app = getApp();
  const roomCode = generateRoomCode();
  const roomDoc = {
    roomCode,
    status: 'waiting', // waiting | ready
    aSubmitted: false,
    bSubmitted: false,
    rawA: serializeRaw(createEmptyRaw()),
    rawB: serializeRaw(createEmptyRaw()),
    exitA: false,
    exitB: false,
    closed: false,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  if (app && app.globalData && app.globalData.cloudReady) {
    const db = wx.cloud.database();
    await db.collection('cpti_rooms').doc(roomCode).set({ data: roomDoc });
  } else {
    const rooms = getLocalRooms();
    // 顺手清理过期本地房间
    Object.keys(rooms).forEach(k => {
      if (isRoomExpired(rooms[k])) delete rooms[k];
    });
    rooms[roomCode] = roomDoc;
    saveLocalRooms(rooms);
  }
  return roomDoc;
}

async function getRoom(roomCode) {
  const code = (roomCode || '').trim().toUpperCase();
  if (!code) return null;
  const app = getApp();

  if (app && app.globalData && app.globalData.cloudReady) {
    const db = wx.cloud.database();
    try {
      const res = await db.collection('cpti_rooms').doc(code).get();
      const room = res.data || null;
      if (!room || isRoomExpired(room) || isRoomClosed(room)) return null;
      return room;
    } catch (e) {
      return null;
    }
  }

  const rooms = getLocalRooms();
  const room = rooms[code] || null;
  if (!room || isRoomExpired(room) || isRoomClosed(room)) return null;
  return room;
}

async function submitSeatAnswers(roomCode, seat, rawAnswers) {
  const code = (roomCode || '').trim().toUpperCase();
  const cleanSeat = seat === 'B' ? 'B' : 'A';
  const app = getApp();
  const cleanRaw = serializeRaw(rawAnswers);

  if (app && app.globalData && app.globalData.cloudReady) {
    // 优先走原子云函数防并发覆盖与重复覆盖
    try {
      const cfRes = await wx.cloud.callFunction({
        name: 'cptiSync',
        data: { action: 'submit', roomCode: code, seat: cleanSeat, raw: cleanRaw }
      });
      if (cfRes && cfRes.result) {
        if (!cfRes.result.ok) {
          throw new Error(cfRes.result.message || cfRes.result.error || '提交失败');
        }
        if (cfRes.result.room) return cfRes.result.room;
        const refreshed = await getRoom(code);
        if (refreshed) return refreshed;
        const err = new Error('提交成功，但房间状态同步延迟，请稍后重试');
        err._cloudSynced = true;
        throw err;
      }
    } catch (e) {
      if (e && (e._cloudSynced || (e.message && e.message.includes('已交卷')))) throw e;
      const db = wx.cloud.database();
      const latestBefore = await getRoom(code);
      if (!latestBefore) throw new Error('房间不存在或已过期');
      if (cleanSeat === 'A' && latestBefore.aSubmitted) throw new Error('发起方席位已交卷，请勿重复提交');
      if (cleanSeat === 'B' && latestBefore.bSubmitted) throw new Error('受邀方席位已交卷，该房间已满员');

      const patch = cleanSeat === 'A'
        ? { rawA: cleanRaw, aSubmitted: true, updatedAt: Date.now() }
        : { rawB: cleanRaw, bSubmitted: true, updatedAt: Date.now() };
      await db.collection('cpti_rooms').doc(code).update({ data: patch });
      const latest = await getRoom(code);
      if (latest && latest.aSubmitted && latest.bSubmitted && latest.status !== 'ready') {
        await db.collection('cpti_rooms').doc(code).update({ data: { status: 'ready', updatedAt: Date.now() } });
        latest.status = 'ready';
      }
      return latest;
    }
  }

  const rooms = getLocalRooms();
  const room = rooms[code];
  if (!room || isRoomExpired(room)) throw new Error('房间不存在或已过期');
  if (cleanSeat === 'A' && room.aSubmitted) throw new Error('发起方席位已交卷，请勿重复提交');
  if (cleanSeat === 'B' && room.bSubmitted) throw new Error('受邀方席位已交卷，该房间已满员');

  if (cleanSeat === 'A') {
    room.rawA = cleanRaw;
    room.aSubmitted = true;
  } else {
    room.rawB = cleanRaw;
    room.bSubmitted = true;
  }
  room.updatedAt = Date.now();
  if (room.aSubmitted && room.bSubmitted) {
    room.status = 'ready';
  }
  rooms[code] = room;
  saveLocalRooms(rooms);
  return room;
}

/**
 * 退出房间：记录席位退出标记。
 * 双方都退出 => 房间直接销毁（云端删文档 / 本地删键），判断结果随之清零，
 * 避免第三个人拿旧房间码进来看到上两个人的结果。
 */
async function exitRoom(roomCode, seat) {
  const code = (roomCode || '').trim().toUpperCase();
  if (!code) return { ok: true, closed: true };
  const cleanSeat = seat === 'B' ? 'B' : 'A';
  const app = getApp();

  if (app && app.globalData && app.globalData.cloudReady) {
    const db = wx.cloud.database();
    try {
      const cfRes = await wx.cloud.callFunction({
        name: 'cptiSync',
        data: { action: 'exit', roomCode: code, seat: cleanSeat }
      });
      if (cfRes && cfRes.result && cfRes.result.ok) return cfRes.result;
    } catch (e) {}

    try {
      const room = await getRoom(code);
      if (!room) return { ok: true, closed: true };
      const exitA = cleanSeat === 'A' ? true : !!room.exitA;
      const exitB = cleanSeat === 'B' ? true : !!room.exitB;
      if (exitA && exitB) {
        try {
          await db.collection('cpti_rooms').doc(code).remove();
        } catch (e) {
          await db.collection('cpti_rooms').doc(code).update({
            data: { exitA: true, exitB: true, closed: true, updatedAt: Date.now() }
          });
        }
        return { ok: true, closed: true };
      }
      await db.collection('cpti_rooms').doc(code).update({
        data: cleanSeat === 'A' ? { exitA: true, updatedAt: Date.now() } : { exitB: true, updatedAt: Date.now() }
      });
      return { ok: true, closed: false };
    } catch (e) {
      return { ok: false, closed: false, error: e && e.message };
    }
  }

  const rooms = getLocalRooms();
  const room = rooms[code];
  if (!room) return { ok: true, closed: true };
  const exitA = cleanSeat === 'A' ? true : !!room.exitA;
  const exitB = cleanSeat === 'B' ? true : !!room.exitB;
  if (exitA && exitB) {
    delete rooms[code];
    saveLocalRooms(rooms);
    return { ok: true, closed: true };
  }
  room.exitA = exitA;
  room.exitB = exitB;
  room.updatedAt = Date.now();
  rooms[code] = room;
  saveLocalRooms(rooms);
  return { ok: true, closed: false };
}

function watchRoom(roomCode, onChange, onMissing, onError) {
  const code = (roomCode || '').trim().toUpperCase();
  const app = getApp();

  if (app && app.globalData && app.globalData.cloudReady) {
    const db = wx.cloud.database();
    const watcher = db.collection('cpti_rooms').doc(code).watch({
      onChange(snapshot) {
        if (snapshot && snapshot.docs && snapshot.docs[0]) {
          const doc = snapshot.docs[0];
          if (isRoomExpired(doc) || isRoomClosed(doc)) {
            if (onMissing) onMissing();
          } else {
            onChange(doc);
          }
        } else if (snapshot && snapshot.type !== 'init') {
          if (onMissing) onMissing();
        }
      },
      onError(err) {
        console.warn('[CPTI] 房间监听异常:', err);
        if (onError) onError(err);
      }
    });
    return () => watcher.close();
  }

  const timer = setInterval(async () => {
    const room = await getRoom(code);
    if (room) {
      onChange(room);
    } else if (onMissing) {
      onMissing();
    }
  }, 1500);
  return () => clearInterval(timer);
}

function saveActiveRoom(roomCode, seat, extra = {}) {
  try {
    const prev = getActiveRoom();
    const owner = (prev && prev.roomCode === roomCode && prev.owner) || extra.owner === true;
    wx.setStorageSync(ACTIVE_ROOM_KEY, {
      roomCode,
      seat,
      owner,
      savedAt: Date.now()
    });
  } catch (e) {}
}

function getActiveRoom() {
  try {
    return wx.getStorageSync(ACTIVE_ROOM_KEY) || null;
  } catch (e) {
    return null;
  }
}

function clearActiveRoom() {
  try {
    wx.removeStorageSync(ACTIVE_ROOM_KEY);
  } catch (e) {}
}

module.exports = {
  ACTIVE_ROOM_KEY,
  createRoom,
  getRoom,
  submitSeatAnswers,
  watchRoom,
  exitRoom,
  saveActiveRoom,
  getActiveRoom,
  clearActiveRoom
};
