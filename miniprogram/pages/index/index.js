const { HOME_ASSETS, SHARE_IMAGE } = require('../../utils/assets');
const { getRoom, getActiveRoom } = require('../../utils/room_service');

Page({
  data: {
    heroImg: HOME_ASSETS.hero,
    entrySoloImg: HOME_ASSETS.entrySolo,
    entryPairImg: HOME_ASSETS.entryPair,
    heroImgError: false,
    soloImgError: false,
    pairImgError: false,
    hasSoloReport: false,
    lastSoloTitle: '',
    lastSoloCode: '',
    pairRoomCode: '',
    pairRoomReady: false,
    pairRoomMySubmitted: false
  },

  onLoad(options) {
    if (options && options.roomCode) {
      let code = '';
      try {
        code = decodeURIComponent(options.roomCode).trim().toUpperCase();
      } catch (e) {}
      if (code) {
        wx.navigateTo({
          url: `/pages/room/room?roomCode=${encodeURIComponent(code)}&seat=B`
        });
      }
    }
  },

  onShow() {
    const app = getApp();
    let res = app && app.globalData && app.globalData.soloResult;
    if (!res) {
      try {
        res = wx.getStorageSync('CPTI_LAST_SOLO_REPORT') || null;
        if (res && app && app.globalData) {
          app.globalData.soloResult = res;
        }
      } catch (e) {}
    }
    if (res) {
      this.setData({
        hasSoloReport: true,
        lastSoloTitle: res.title,
        lastSoloCode: res.code
      });
    }
    this.refreshPairEntry();
  },

  // 回主页后仍能看到双人房间进度：对方是否已交卷，避免用户以为“卡住了”
  async refreshPairEntry() {
    const active = getActiveRoom();
    if (!active || !active.roomCode) {
      if (this.data.pairRoomCode) {
        this.setData({ pairRoomCode: '', pairRoomReady: false, pairRoomMySubmitted: false });
      }
      return;
    }
    const room = await getRoom(active.roomCode);
    if (!room) {
      this.setData({ pairRoomCode: '', pairRoomReady: false, pairRoomMySubmitted: false });
      return;
    }
    const bothReady = room.status === 'ready' || (room.aSubmitted && room.bSubmitted);
    const mySubmitted = active.seat === 'A' ? !!room.aSubmitted : !!room.bSubmitted;
    this.setData({
      pairRoomCode: room.roomCode,
      pairRoomReady: bothReady,
      pairRoomMySubmitted: mySubmitted
    });
  },

  goDebug() {
    const app = getApp();
    let envVersion = '';
    try {
      envVersion = (wx.getAccountInfoSync && wx.getAccountInfoSync().miniProgram.envVersion) || '';
    } catch (e) {}
    const allow = !!(app && app.globalData && app.globalData.debug)
      && (!envVersion || envVersion === 'develop' || envVersion === 'trial');
    if (!allow) return;
    wx.navigateTo({
      url: '/pages/debug/debug'
    });
  },

  onHeroImgError() { this.setData({ heroImgError: true }); },
  onSoloImgError() { this.setData({ soloImgError: true }); },
  onPairImgError() { this.setData({ pairImgError: true }); },

  startSolo() {
    wx.navigateTo({
      url: '/pages/quiz/quiz?mode=solo'
    });
  },

  goPairRoom() {
    wx.navigateTo({
      url: '/pages/room/room'
    });
  },

  openLastSoloReport() {
    wx.navigateTo({
      url: '/pages/report/report?mode=solo'
    });
  },

  onShareAppMessage() {
    return {
      title: 'CPTI 恋爱人格测验｜测清你们在亲密关系里的真实角色',
      path: '/pages/index/index',
      imageUrl: SHARE_IMAGE
    };
  }
});
