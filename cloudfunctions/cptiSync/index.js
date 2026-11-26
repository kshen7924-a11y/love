const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

exports.main = async (event) => {
  const { action, roomCode, seat, raw } = event || {};
  const code = (roomCode || '').trim().toUpperCase();
  const cleanSeat = seat === 'B' ? 'B' : 'A';
  if (!code) return { ok: false, error: 'INVALID_ROOM_CODE', message: '房间码格式无效' };

  if (action === 'submit') {
    const docRef = db.collection('cpti_rooms').doc(code);
    let snap;
    try {
      snap = await docRef.get();
    } catch (e) {
      return { ok: false, error: 'ROOM_NOT_FOUND', message: '房间不存在或已失效' };
    }
    const room = snap.data;
    if (!room) return { ok: false, error: 'ROOM_NOT_FOUND', message: '房间不存在或已失效' };
    if (room.createdAt && Date.now() - Number(room.createdAt) > ROOM_TTL_MS) {
      return { ok: false, error: 'ROOM_EXPIRED', message: '该房间已超过 24 小时有效期，请重新创建' };
    }

    if (cleanSeat === 'A' && room.aSubmitted) {
      return { ok: false, error: 'SEAT_TAKEN', message: '发起方（席位 A）已交卷，请勿重复提交' };
    }
    if (cleanSeat === 'B' && room.bSubmitted) {
      return { ok: false, error: 'SEAT_TAKEN', message: '受邀方（席位 B）已交卷，该房间已满员' };
    }

    const aSubmitted = cleanSeat === 'A' ? true : !!room.aSubmitted;
    const bSubmitted = cleanSeat === 'B' ? true : !!room.bSubmitted;
    const status = aSubmitted && bSubmitted ? 'ready' : 'waiting';

    const patch = {
      aSubmitted,
      bSubmitted,
      status,
      updatedAt: Date.now()
    };
    if (cleanSeat === 'A') patch.rawA = raw;
    if (cleanSeat === 'B') patch.rawB = raw;

    await docRef.update({ data: patch });
    return {
      ok: true,
      room: { ...room, ...patch }
    };
  }

  if (action === 'exit') {
    const docRef = db.collection('cpti_rooms').doc(code);
    let snap;
    try {
      snap = await docRef.get();
    } catch (e) {
      // 读取失败可能是房间已被销毁，也可能是瞬时异常；交给客户端兜底判断，避免误清
      return { ok: false, error: 'ROOM_READ_FAIL', message: '房间状态读取失败' };
    }
    const room = snap.data;
    if (!room) return { ok: true, closed: true };

    const exitA = cleanSeat === 'A' ? true : !!room.exitA;
    const exitB = cleanSeat === 'B' ? true : !!room.exitB;

    // 双方都退出：销毁房间，判断结果一并清零，避免第三人复用房间码误判
    if (exitA && exitB) {
      try {
        await docRef.remove();
        return { ok: true, closed: true };
      } catch (e) {
        // 删不掉也要把 closed 落库，保证后续任何入口都读不到这个房间
        try {
          await docRef.update({ data: { exitA: true, exitB: true, closed: true, updatedAt: Date.now() } });
        } catch (e2) {}
        return { ok: true, closed: true };
      }
    }

    await docRef.update({
      data: cleanSeat === 'A'
        ? { exitA: true, updatedAt: Date.now() }
        : { exitB: true, updatedAt: Date.now() }
    });
    return { ok: true, closed: false };
  }

  return { ok: false, error: 'UNKNOWN_ACTION', message: '未知操作类型' };
};
