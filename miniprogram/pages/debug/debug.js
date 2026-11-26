const { createEmptyRaw, evaluateReport } = require('../../utils/cpti_engine');
const {
  createRoom,
  getRoom,
  submitSeatAnswers,
  getActiveRoom,
  saveActiveRoom
} = require('../../utils/room_service');

function makeRaw(offset = 0) {
  return createEmptyRaw().map((_, i) => {
    const v = (i + offset) % 3;
    return v === 0 ? 1 : (v === 1 ? -1 : 0);
  });
}

Page({
  data: {
    debug: false,
    cloudReady: false,
    cloudEnvId: '',
    roomCode: '',
    logs: []
  },

  onLoad() {
    const app = getApp();
    const gd = (app && app.globalData) || {};
    const active = getActiveRoom();
    this.setData({
      debug: !!gd.debug,
      cloudReady: !!gd.cloudReady,
      cloudEnvId: gd.cloudEnvId || '未配置（本地模式）',
      roomCode: active && active.roomCode ? active.roomCode : ''
    });
    this.pushLog('测试面板已打开');
  },

  pushLog(msg) {
    const time = new Date().toLocaleTimeString();
    this.setData({
      logs: [`[${time}] ${msg}`, ...this.data.logs].slice(0, 8)
    });
  },

  clearAll() {
    try {
      const info = wx.getStorageInfoSync();
      (info.keys || []).filter(k => k.indexOf('CPTI_') === 0).forEach(k => {
        wx.removeStorageSync(k);
      });
      this.pushLog('已清除所有 CPTI_ 本地缓存');
    } catch (e) {
      this.pushLog('清缓存失败：' + (e.message || '未知错误'));
    }
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.soloResult = null;
      app.globalData.pairResult = null;
      app.globalData.pairRoom = null;
    }
    this.setData({ roomCode: '' });
  },

  makeSoloReport() {
    const report = evaluateReport('solo', makeRaw());
    try {
      wx.setStorageSync('CPTI_LAST_SOLO_REPORT', report);
    } catch (e) {}
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.soloResult = report;
    }
    this.pushLog('已生成单人报告：' + report.title + ' ' + report.code);
    wx.navigateTo({
      url: '/pages/report/report?mode=solo'
    });
  },

  async makePairRoom() {
    try {
      const room = await createRoom();
      saveActiveRoom(room.roomCode, 'A', { owner: true });
      this.setData({ roomCode: room.roomCode });
      this.pushLog('已创建双人房间：' + room.roomCode);
      wx.navigateTo({
        url: `/pages/room/room?roomCode=${room.roomCode}&seat=A`
      });
    } catch (e) {
      this.pushLog('创建房间失败：' + (e.message || '未知错误'));
    }
  },

  async submitBoth() {
    const active = getActiveRoom();
    const code = (this.data.roomCode || (active && active.roomCode) || '').trim().toUpperCase();
    if (!code) {
      this.pushLog('没有可用房间，请先创建双人测试房间');
      return;
    }
    try {
      await submitSeatAnswers(code, 'A', makeRaw(0));
      this.pushLog('席位 A 已提交');
      const second = await submitSeatAnswers(code, 'B', makeRaw(1));
      this.pushLog('席位 B 已提交，状态：' + (second && second.status));
      const room = await getRoom(code);
      if (room && (room.status === 'ready' || (room.aSubmitted && room.bSubmitted))) {
        const report = evaluateReport('pair', room.rawA, room.rawB);
        const app = getApp();
        if (app && app.globalData) {
          app.globalData.pairRoom = room;
          app.globalData.pairResult = report;
        }
        this.pushLog('双人报告已生成：' + report.title + ' ' + report.code);
        wx.navigateTo({
          url: `/pages/report/report?mode=pair&roomCode=${code}`
        });
      } else {
        wx.navigateTo({
          url: `/pages/room/room?roomCode=${code}&seat=A&waiting=1`
        });
      }
    } catch (e) {
      this.pushLog('提交失败：' + (e.message || '未知错误'));
    }
  },

  goHome() {
    wx.reLaunch({ url: '/pages/index/index' });
  }
});
