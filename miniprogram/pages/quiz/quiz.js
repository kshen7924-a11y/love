const {
  LEVELS,
  AXIS_META,
  EXTRA_AXIS_NAMES,
  QUESTIONS
} = require('../../utils/cpti_data');
const {
  createEmptyRaw,
  shouldAskQuestion,
  getNextQuestionIndex,
  getPrevQuestionIndex,
  getVisibleProgress,
  evaluateReport
} = require('../../utils/cpti_engine');
const { submitSeatAnswers } = require('../../utils/room_service');

const PAIR_SUBMIT_AT_PREFIX = 'CPTI_PAIR_SUBMIT_AT';
const SUBMIT_TIMEOUT_MS = 15000;

// 网络/云函数可能长时间不返回，加超时兜底，避免 submitting 与 _advancing 永久锁死
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('网络超时，请检查网络后重试'));
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

Page({
  data: {
    mode: 'solo', // solo | pair
    roomCode: '',
    seat: 'A',
    currentIndex: 0,
    rawAnswers: [],
    levels: LEVELS,
    axisTag: '',
    axisColor: '#33A474',
    axisBg: '#E8F6F0',
    questionText: '',
    roastText: '',
    selectedValue: null,
    progressCurrent: 1,
    progressTotal: 12,
    progressPercent: 8,
    canGoPrev: false,
    resumedFromDraft: false,
    showSourceStep: false,
    submitting: false
  },

  onLoad(options) {
    this._advancing = false;
    this._completedSubmit = false;
    const mode = options.mode === 'pair' ? 'pair' : 'solo';
    const roomCode = (options.roomCode || '').trim().toUpperCase();
    const seat = options.seat === 'B' ? 'B' : 'A';

    if (mode === 'pair' && !roomCode) {
      wx.showToast({ title: '缺少房间号参数', icon: 'none' });
      wx.redirectTo({ url: '/pages/room/room' });
      return;
    }

    wx.setNavigationBarTitle({
      title: mode === 'pair' ? `双人盲答 · 席位 ${seat}` : '单人恋爱人格测评'
    });

    let rawAnswers = createEmptyRaw();
    let startIdx = 0;
    let resumedFromDraft = false;
    let resumeAtSourceStep = false;
    const draft = this.loadDraft(mode, roomCode, seat);
    if (draft && Array.isArray(draft.rawAnswers) && draft.rawAnswers.length === rawAnswers.length) {
      const answeredLen = draft.rawAnswers.filter(v => v !== null).length;
      if (answeredLen > 0) {
        rawAnswers = draft.rawAnswers;
        startIdx = this.findResumeIndex(rawAnswers);
        resumedFromDraft = true;
        const answerAtResume = rawAnswers[startIdx];
        const hasPending = startIdx !== -1
          && (answerAtResume === null || answerAtResume === undefined || answerAtResume === 'UNASKED');
        resumeAtSourceStep = mode === 'solo' && startIdx !== -1 && !hasPending;
      }
    }

    this.setData({ mode, roomCode, seat, rawAnswers, resumedFromDraft }, () => {
      this.syncQuestionView(startIdx, { showSourceStep: resumeAtSourceStep });
    });
  },

  onHide() {
    if (!this._completedSubmit && Array.isArray(this.data.rawAnswers)) {
      const cnt = this.data.rawAnswers.filter(v => v !== null).length;
      if (cnt >= 1) {
        this.saveDraft(this.data.rawAnswers);
      }
    }
  },

  onUnload() {
    // 意外退出时若未完成提交且已答 >= 1 题，保存草稿便于下次续答
    if (!this._completedSubmit && Array.isArray(this.data.rawAnswers)) {
      const cnt = this.data.rawAnswers.filter(v => v !== null).length;
      if (cnt >= 1) {
        this.saveDraft(this.data.rawAnswers);
      }
    }
  },

  restartQuiz() {
    wx.showModal({
      title: '重新开始作答？',
      content: '当前已填写的进度将被清空，确定要从第 1 题重测吗？',
      confirmText: '从头重测',
      success: (res) => {
        if (res.confirm) {
          this.clearDraft();
          const fresh = createEmptyRaw();
          this.setData({ rawAnswers: fresh, resumedFromDraft: false }, () => {
            this.syncQuestionView(0);
          });
        }
      }
    });
  },

  getDraftKey(mode, roomCode, seat) {
    return mode === 'pair'
      ? `CPTI_DRAFT_PAIR_${roomCode}_${seat}`
      : 'CPTI_DRAFT_SOLO';
  },

  loadDraft(mode, roomCode, seat) {
    try {
      return wx.getStorageSync(this.getDraftKey(mode, roomCode, seat)) || null;
    } catch (e) {
      return null;
    }
  },

  saveDraft(rawAnswers) {
    try {
      wx.setStorageSync(this.getDraftKey(this.data.mode, this.data.roomCode, this.data.seat), {
        rawAnswers,
        updatedAt: Date.now()
      });
    } catch (e) {}
  },

  clearDraft() {
    try {
      wx.removeStorageSync(this.getDraftKey(this.data.mode, this.data.roomCode, this.data.seat));
    } catch (e) {}
  },

  findResumeIndex(rawAnswers) {
    let lastVisible = -1;
    for (let i = 0; i < QUESTIONS.length; i++) {
      if (!shouldAskQuestion(i, rawAnswers)) continue;
      lastVisible = i;
      if (rawAnswers[i] === null || rawAnswers[i] === undefined || rawAnswers[i] === 'UNASKED') {
        return i;
      }
    }
    return lastVisible;
  },

  syncQuestionView(index, options = {}) {
    const q = QUESTIONS[index];
    const isPair = this.data.mode === 'pair';
    const prog = getVisibleProgress(index, this.data.rawAnswers);
    const prevIdx = getPrevQuestionIndex(index, this.data.rawAnswers);

    let axisTag = '';
    let axisColor = '#33A474';
    let axisBg = '#E8F6F0';

    if (q.axis <= 3) {
      const meta = AXIS_META[q.axis];
      axisTag = `${meta.name} · ${meta.posCode}/${meta.negCode}`;
      axisColor = meta.color;
      const bgMap = {
        '#33A474': '#E8F6F0',
        '#4298B4': '#EAF5F8',
        '#88619A': '#F3EDF6',
        '#E4AE3A': '#FCF6E8'
      };
      axisBg = bgMap[axisColor] || '#E8F6F0';
    } else {
      axisTag = EXTRA_AXIS_NAMES[q.axis] || '六维需求直测';
      axisColor = q.axis === 4 ? '#4298B4' : '#B85D6F';
      axisBg = q.axis === 4 ? '#EAF5F8' : '#FCEEF1';
    }

    const curVal = this.data.rawAnswers[index];
    const showSourceStep = options.showSourceStep === true;
    this.setData({
      currentIndex: index,
      showSourceStep,
      axisTag,
      axisColor,
      axisBg,
      questionText: isPair ? q.couple : q.solo,
      roastText: isPair ? q.coupleRoast : q.soloRoast,
      selectedValue: typeof curVal === 'number' ? curVal : null,
      progressCurrent: prog.current,
      progressTotal: prog.total,
      progressPercent: showSourceStep ? 100 : Math.round((prog.current / prog.total) * 100),
      canGoPrev: prevIdx !== -1
    });
  },

  selectOption(e) {
    const score = Number(e.currentTarget.dataset.score);
    this.recordAndAdvance(score);
  },

  skipQuestion() {
    this.recordAndAdvance('SKIP');
  },

  async recordAndAdvance(val) {
    if (this._completedSubmit || this.data.submitting || this._advancing) return;
    this._advancing = true;
    let lockKept = false;

    try {
      const nextRaw = [...this.data.rawAnswers];
      nextRaw[this.data.currentIndex] = val;

      for (let i = this.data.currentIndex + 1; i < nextRaw.length; i++) {
        if (QUESTIONS[i].isFollowup) nextRaw[i] = null;
      }

      this.saveDraft(nextRaw);
      const nextIdx = getNextQuestionIndex(this.data.currentIndex, nextRaw);
      this.setData({
        rawAnswers: nextRaw,
        selectedValue: typeof val === 'number' ? val : null
      });

      if (nextIdx !== -1) {
        lockKept = true;
        setTimeout(() => {
          try {
            this.syncQuestionView(nextIdx);
          } catch (e) {
            // 同步题目失败不阻断解锁，避免选项点击被永久忽略
          } finally {
            this._advancing = false;
          }
        }, 110);
        return;
      }

      if (this.data.mode === 'solo') {
        this.setData({
          showSourceStep: true,
          progressPercent: 100
        });
      } else {
        await this.submitPairQuiz(nextRaw);
      }
    } catch (e) {
      this.setData({ submitting: false });
    } finally {
      // 关键：任何异常/超时都必须解锁，否则选项点击会被永久忽略（表现为“卡死”）
      if (!lockKept) this._advancing = false;
    }
  },

  goPrev() {
    if (this._advancing || this.data.submitting) return;
    const prevIdx = getPrevQuestionIndex(this.data.currentIndex, this.data.rawAnswers);
    if (prevIdx !== -1) {
      this.syncQuestionView(prevIdx);
    }
  },

  getLastVisibleQuestionIndex(rawAnswers) {
    for (let i = QUESTIONS.length - 1; i >= 0; i--) {
      if (shouldAskQuestion(i, rawAnswers)) return i;
    }
    return 0;
  },

  backFromSource() {
    const targetIdx = shouldAskQuestion(this.data.currentIndex, this.data.rawAnswers)
      ? this.data.currentIndex
      : this.getLastVisibleQuestionIndex(this.data.rawAnswers);
    this.syncQuestionView(targetIdx);
  },

  finishSoloWithSource(e) {
    if (this._completedSubmit) return;
    this._completedSubmit = true;
    const source = e.currentTarget.dataset.source || 'real';
    const report = evaluateReport('solo', this.data.rawAnswers, null, {
      experienceSource: source
    });
    this.clearDraft();
    try {
      wx.setStorageSync('CPTI_LAST_SOLO_REPORT', report);
    } catch (err) {}
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.soloResult = report;
    }
    wx.redirectTo({
      url: '/pages/report/report?mode=solo'
    });
  },

  async submitPairQuiz(finalRaw) {
    if (this._completedSubmit) return;
    this.setData({ submitting: true });
    wx.showLoading({ title: '正在加密提交...', mask: true });
    const startedAt = Date.now();
    try {
      const room = await withTimeout(
        submitSeatAnswers(this.data.roomCode, this.data.seat, finalRaw),
        SUBMIT_TIMEOUT_MS
      );
      wx.hideLoading();
      this._completedSubmit = true;
      this.clearDraft();
      try {
        wx.setStorageSync(`${PAIR_SUBMIT_AT_PREFIX}_${this.data.roomCode}_${this.data.seat}`, Date.now());
      } catch (e) {}
      this.setData({ submitting: false });

      if (room && (room.status === 'ready' || (room.aSubmitted && room.bSubmitted))) {
        const report = evaluateReport('pair', room.rawA, room.rawB);
        const app = getApp();
        if (app && app.globalData) {
          app.globalData.pairRoom = room;
          app.globalData.pairResult = report;
        }
        wx.redirectTo({
          url: `/pages/report/report?mode=pair&roomCode=${this.data.roomCode}`
        });
      } else {
        wx.redirectTo({
          url: `/pages/room/room?roomCode=${this.data.roomCode}&seat=${this.data.seat}&waiting=1`
        });
      }
    } catch (err) {
      wx.hideLoading();
      this.setData({ submitting: false });
      if (err && err._cloudSynced) {
        this._completedSubmit = true;
        this.clearDraft();
        try {
          wx.setStorageSync(`${PAIR_SUBMIT_AT_PREFIX}_${this.data.roomCode}_${this.data.seat}`, Date.now());
        } catch (e) {}
        wx.redirectTo({
          url: `/pages/room/room?roomCode=${this.data.roomCode}&seat=${this.data.seat}&waiting=1`
        });
        return;
      }
      wx.showToast({
        title: err.message || '提交失败，请重试',
        icon: 'none'
      });
    }
  }
});
