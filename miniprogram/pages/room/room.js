const {
  createRoom,
  getRoom,
  watchRoom,
  exitRoom,
  saveActiveRoom: persistActiveRoom,
  getActiveRoom: readActiveRoom,
  clearActiveRoom: removeActiveRoom
} = require('../../utils/room_service');
const { evaluateReport } = require('../../utils/cpti_engine');
const { SHARE_IMAGE } = require('../../utils/assets');

const PAIR_SUBMIT_AT_PREFIX = 'CPTI_PAIR_SUBMIT_AT';

Page({
  data: {
    roomCode: '',
    seat: 'A',
    isGuest: false,
    inputCode: '',
    creating: false,
    joining: false,
    aSubmitted: false,
    bSubmitted: false,
    mySubmitted: false,
    bothReady: false,
    otherExited: false,
    hasDraft: false,
    waitingText: '',
    localMode: false,
    roomError: false,
    roomErrorTitle: '',
    roomErrorDesc: ''
  },

  onLoad(options) {
    this._autoJumped = false;
    this._redirecting = false;
    this._waitFrom = 0;
    this._waitTimer = null;
    this._pollTimer = null;
    this._autoJumpTimer = null;

    // 未接云开发时房间只落在本机，跨手机永远等不到对方 —— 开发期显式提示，避免误判为“卡死”
    const app = getApp();
    const localMode = !!(app && app.globalData && app.globalData.debug && !app.globalData.cloudReady);
    this.setData({ localMode });

    if (options && options.roomCode) {
      let code = '';
      try {
        code = decodeURIComponent(options.roomCode).trim().toUpperCase();
      } catch (e) {}
      if (code) {
        // 仅当本机确实是该房间发起人时，才把分享链接回跳纠正为席位 A；
        // 受邀者即使本机残留同房间记录，也按链接里的 seat=B 进入，避免抢占 A 席。
        const saved = this.getSavedActiveRoom();
        const isOwner = saved && saved.roomCode === code && saved.owner;
        const seat = isOwner ? 'A' : (options.seat === 'B' ? 'B' : 'A');
        this.enterRoom(code, seat, options.waiting === '1');
        return;
      }
    }

    // 若用户上次创建/加入了未过期的双人房间，自动恢复现场
    const saved = this.getSavedActiveRoom();
    if (saved && saved.roomCode) {
      this.enterRoom(saved.roomCode, saved.seat, false);
    }
  },

  async onShow() {
    if (!this.data.roomCode) return;
    const roomCode = this.data.roomCode;
    this.refreshDraftFlag(roomCode, this.data.seat);
    const room = await getRoom(roomCode);
    if (!room) {
      this.handleRoomGone(
        '该房间不存在或已关闭',
        '可能是双方都已退出房间，或分享链接已超过 24 小时有效期。你可以立即新建一个房间重新邀请对方。'
      );
      return;
    }
    this.applyRoomState(room, true);
    // 监听若已失效（云端 watch 报错后会走轮询），这里补齐兜底，避免页面卡在等待态不再刷新
    if (!this._unwatch && !this._pollTimer) this.startWatching(roomCode);
  },

  onHide() {
    this.stopWatching();
    this.stopWaitingTimer();
  },

  onUnload() {
    this.stopWatching();
    this.stopWaitingTimer();
    if (this._autoJumpTimer) {
      clearTimeout(this._autoJumpTimer);
      this._autoJumpTimer = null;
    }
  },

  stopWatching() {
    if (this._unwatch) {
      this._unwatch();
      this._unwatch = null;
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  },

  startWatching(roomCode) {
    this.stopWatching();
    this._unwatch = watchRoom(
      roomCode,
      (room) => {
        this.applyRoomState(room, true);
      },
      () => {
        this.handleRoomGone(
          '房间已关闭或已过期',
          '双方都退出房间后，该房间会被彻底清空，避免第三个人进入后误判。请重新创建房间发起测验。'
        );
      },
      (err) => {
        this.startPollingFallback(roomCode);
      }
    );
  },

  // 云端 watch 断连后的兜底轮询，保证等待页不会永久卡住
  startPollingFallback(roomCode) {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(async () => {
      const room = await getRoom(roomCode);
      if (!room) {
        this.handleRoomGone(
          '房间已关闭或已过期',
          '双方都退出房间后，该房间会被彻底清空，避免第三个人进入后误判。请重新创建房间发起测验。'
        );
        return;
      }
      this.applyRoomState(room, true);
    }, 3000);
  },

  handleRoomGone(title, desc) {
    this.stopWatching();
    this.stopWaitingTimer();
    this.clearSavedActiveRoom();
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.pairRoom = null;
      app.globalData.pairResult = null;
    }
    this.setData({
      roomCode: '',
      waitingText: '',
      otherExited: false,
      roomError: true,
      roomErrorTitle: title,
      roomErrorDesc: desc
    });
  },

  getSavedActiveRoom() {
    return readActiveRoom();
  },

  saveActiveRoom(roomCode, seat, extra = {}) {
    persistActiveRoom(roomCode, seat, extra);
  },

  clearSavedActiveRoom() {
    removeActiveRoom();
  },

  refreshDraftFlag(roomCode, seat) {
    try {
      const draft = wx.getStorageSync(`CPTI_DRAFT_PAIR_${roomCode}_${seat}`);
      const hasDraft = !!(draft && Array.isArray(draft.rawAnswers) && draft.rawAnswers.some(v => v !== null));
      this.setData({ hasDraft });
    } catch (e) {
      this.setData({ hasDraft: false });
    }
  },

  onCodeInput(e) {
    this.setData({ inputCode: (e.detail.value || '').toUpperCase() });
  },

  copyRoomCode() {
    if (!this.data.roomCode) return;
    wx.setClipboardData({
      data: this.data.roomCode,
      success: () => {
        wx.showToast({ title: '房间号已复制', icon: 'success' });
      }
    });
  },

  async handleCreateRoom() {
    if (this.data.creating) return;
    this.setData({ creating: true });
    wx.showLoading({ title: '创建房间中...' });
    try {
      const room = await createRoom();
      wx.hideLoading();
      this.setData({ creating: false });
      this.saveActiveRoom(room.roomCode, 'A', { owner: true });
      this.enterRoom(room.roomCode, 'A', false);
    } catch (e) {
      wx.hideLoading();
      this.setData({ creating: false });
      wx.showToast({ title: '创建失败，请重试', icon: 'none' });
    }
  },

  async handleJoinRoom() {
    if (this.data.joining) return;
    const code = this.data.inputCode.trim().toUpperCase();
    if (code.length < 4) {
      wx.showToast({ title: '请输入完整房间码', icon: 'none' });
      return;
    }
    this.setData({ joining: true });
    wx.showLoading({ title: '正在查找房间...' });
    const room = await getRoom(code);
    wx.hideLoading();
    this.setData({ joining: false });

    if (!room) {
      wx.showToast({ title: '未找到该房间或已过期', icon: 'none' });
      return;
    }
    const saved = this.getSavedActiveRoom();
    const seat = (saved && saved.roomCode === code) ? saved.seat : 'B';
    this.enterRoom(code, seat, false);
  },

  async enterRoom(roomCode, seat, isWaitingAfterSubmit) {
    this.stopWatching();
    this._autoJumped = false;
    this._redirecting = false;
    this._waitFrom = 0;
    if (this._autoJumpTimer) {
      clearTimeout(this._autoJumpTimer);
      this._autoJumpTimer = null;
    }

    wx.showLoading({ title: '同步房间状态...' });
    const initial = await getRoom(roomCode);
    wx.hideLoading();

    if (!initial) {
      this.handleRoomGone(
        '该房间不存在或已关闭',
        '可能是双方都已退出房间，或分享链接已超过 24 小时有效期。你可以立即新建一个房间重新邀请对方。'
      );
      return;
    }

    // 席位防抢占：非本机已登记成员，不允许进入已交卷的席位，避免第三人复用旧房间看到旧结果
    const saved = this.getSavedActiveRoom();
    const isKnownMember = saved && saved.roomCode === roomCode && saved.seat === seat;
    if (!isKnownMember) {
      if (seat === 'B' && initial.bSubmitted) {
        this.setData({
          roomCode: '',
          roomError: true,
          roomErrorTitle: '该房间双人席位已满',
          roomErrorDesc: '该房间的两位参与者均已锁定席位并完成作答，你可以重新创建一个新房间发起测试。'
        });
        return;
      }
      if (seat === 'A' && initial.aSubmitted) {
        this.setData({
          roomCode: '',
          roomError: true,
          roomErrorTitle: '该房间发起方席位已交卷',
          roomErrorDesc: '该房间已有成员完成发起方作答，为避免结果混淆，请新建一个房间重新邀请。'
        });
        return;
      }
    }

    this.saveActiveRoom(roomCode, seat);
    this.refreshDraftFlag(roomCode, seat);
    this.setData({
      roomCode,
      seat,
      isGuest: seat === 'B',
      roomError: false,
      waitingText: ''
    });

    this.applyRoomState(initial, isWaitingAfterSubmit);
    this.startWatching(roomCode);
  },

  applyRoomState(room, canAutoJump) {
    if (!room) return;
    const seat = this.data.seat;
    const aSubmitted = !!room.aSubmitted;
    const bSubmitted = !!room.bSubmitted;
    const mySubmitted = seat === 'A' ? aSubmitted : bSubmitted;
    const bothReady = room.status === 'ready' || (aSubmitted && bSubmitted);
    const otherExited = seat === 'A' ? !!room.exitB : !!room.exitA;

    this.setData({
      aSubmitted,
      bSubmitted,
      mySubmitted,
      bothReady,
      otherExited
    });

    if (bothReady) {
      this.stopWaitingTimer();
      if (this.data.waitingText) this.setData({ waitingText: '' });
      const report = evaluateReport('pair', room.rawA, room.rawB);
      const app = getApp();
      if (app && app.globalData) {
        app.globalData.pairRoom = room;
        app.globalData.pairResult = report;
      }
      // 双方刚凑齐时，自动丝滑跳转揭晓双人报告（仅触发一次）
      if (canAutoJump && !this._autoJumped && !this._redirecting) {
        this._autoJumped = true;
        wx.showToast({ title: '双方已交卷，正在揭晓...', icon: 'success', duration: 900 });
        this._autoJumpTimer = setTimeout(() => {
          this._autoJumpTimer = null;
          this.openPairReport();
        }, 700);
      }
      return;
    }

    if (mySubmitted) {
      this.startWaitingTimer(room);
    } else {
      this.stopWaitingTimer();
    }
  },

  // 已交卷等待对方时，展示“已等待多久”，并允许先回主页稍后再来
  startWaitingTimer(room) {
    if (!this._waitFrom) {
      let localAt = 0;
      try {
        localAt = Number(wx.getStorageSync(`${PAIR_SUBMIT_AT_PREFIX}_${this.data.roomCode}_${this.data.seat}`)) || 0;
      } catch (e) {}
      this._waitFrom = localAt || Number(room.updatedAt) || Number(room.createdAt) || Date.now();
    }
    this.updateWaitingText();
    if (!this._waitTimer) {
      this._waitTimer = setInterval(() => this.updateWaitingText(), 30000);
    }
  },

  updateWaitingText() {
    if (!this._waitFrom) return;
    const mins = Math.max(0, Math.floor((Date.now() - this._waitFrom) / 60000));
    let text = '刚刚交卷，正在等对方...';
    if (mins >= 60) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      text = `已等待 ${h} 小时${m ? ` ${m} 分钟` : ''}，对方还没完成`;
    } else if (mins >= 1) {
      text = `已等待 ${mins} 分钟，对方还没完成`;
    }
    if (this.data.waitingText === text) return;
    this.setData({ waitingText: text });
  },

  stopWaitingTimer() {
    if (this._waitTimer) {
      clearInterval(this._waitTimer);
      this._waitTimer = null;
    }
  },

  startMyQuiz() {
    wx.navigateTo({
      url: `/pages/quiz/quiz?mode=pair&roomCode=${this.data.roomCode}&seat=${this.data.seat}`
    });
  },

  openPairReport() {
    if (this._redirecting) return;
    this._redirecting = true;
    if (this._autoJumpTimer) {
      clearTimeout(this._autoJumpTimer);
      this._autoJumpTimer = null;
    }
    wx.redirectTo({
      url: `/pages/report/report?mode=pair&roomCode=${this.data.roomCode}`,
      fail: () => {
        this._redirecting = false;
      }
    });
  },

  confirmResetRoom() {
    wx.showModal({
      title: '退出当前房间？',
      content: '退出后将清除本机当前房间进度。若双方都点击退出，该房间会被彻底清空，避免他人进入后看到旧结果。',
      confirmText: '确认退出',
      confirmColor: '#E11D48',
      success: (res) => {
        if (res.confirm) {
          this.resetRoom();
        }
      }
    });
  },

  async resetRoom() {
    const roomCode = this.data.roomCode;
    const seat = this.data.seat;

    this.stopWatching();
    this.stopWaitingTimer();
    this._waitFrom = 0;
    if (this._autoJumpTimer) {
      clearTimeout(this._autoJumpTimer);
      this._autoJumpTimer = null;
    }

    let closed = false;
    if (roomCode) {
      wx.showLoading({ title: '正在退出房间...', mask: true });
      try {
        const res = await exitRoom(roomCode, seat);
        closed = !!(res && res.closed);
      } catch (e) {
        // 退出接口失败不影响本地清理
      }
      wx.hideLoading();
      try {
        wx.removeStorageSync(`CPTI_DRAFT_PAIR_${roomCode}_${seat}`);
      } catch (e) {}
      try {
        wx.removeStorageSync(`${PAIR_SUBMIT_AT_PREFIX}_${roomCode}_${seat}`);
      } catch (e) {}
    }

    this.clearSavedActiveRoom();
    // 双方都退出 => 房间与判断结果一起清零
    if (closed) {
      const app = getApp();
      if (app && app.globalData) {
        app.globalData.pairRoom = null;
        app.globalData.pairResult = null;
      }
    }

    this.setData({
      roomCode: '',
      seat: 'A',
      inputCode: '',
      aSubmitted: false,
      bSubmitted: false,
      mySubmitted: false,
      bothReady: false,
      otherExited: false,
      hasDraft: false,
      waitingText: '',
      roomError: false
    });
    wx.showToast({ title: closed ? '房间已清空' : '已退出房间', icon: 'none' });
  },

  clearErrorAndCreate() {
    this.setData({ roomError: false });
    this.handleCreateRoom();
  },

  backToHome() {
    wx.reLaunch({ url: '/pages/index/index' });
  },

  onShareAppMessage() {
    const code = this.data.roomCode;
    const seat = this.data.seat;
    if (!code) {
      return {
        title: '测测我们是哪种情侣？CPTI 双人独立盲答邀请',
        path: '/pages/room/room',
        imageUrl: SHARE_IMAGE
      };
    }
    if (seat === 'B') {
      // 受邀方已交卷：提醒发起方回来看结果
      return {
        title: `我已经答完了，回来看我们的 CPTI 双人合盘（房间码 ${code}）`,
        path: `/pages/room/room?roomCode=${code}&seat=A`,
        imageUrl: SHARE_IMAGE
      };
    }
    return {
      title: `我发起了 CPTI 情侣盲答（房间码 ${code}），快来独立作答测测我们是哪种搭档！`,
      path: `/pages/room/room?roomCode=${code}&seat=B`,
      imageUrl: SHARE_IMAGE
    };
  }
});
