const { getCharacterImage, SHARE_IMAGE } = require('../../utils/assets');
const { getRoom, clearActiveRoom, getActiveRoom } = require('../../utils/room_service');
const { evaluateReport } = require('../../utils/cpti_engine');

Page({
  data: {
    report: null,
    roomCode: '',
    characterImg: '',
    radarLegend: [],
    artLoadError: false,
    aiEnabled: false,
    aiLoading: false,
    aiInsight: ''
  },

  async onLoad(options) {
    const app = getApp();
    const isPair = options && options.mode === 'pair';
    let roomCode = '';
    if (options && options.roomCode) {
      try {
        roomCode = decodeURIComponent(options.roomCode).trim().toUpperCase();
      } catch (e) {}
    }

    const cachedPairRoom = app && app.globalData && app.globalData.pairRoom;
    const cachedPairMatches = isPair && roomCode && cachedPairRoom && cachedPairRoom.roomCode === roomCode;
    if (isPair) console.log('[CPTI][PAIR] 报告加载:', roomCode, '缓存命中:', !!cachedPairMatches);
    let report = isPair
      ? (cachedPairMatches ? app.globalData.pairResult : null)
      : (app && app.globalData && app.globalData.soloResult);

    if (!isPair && !report) {
      try {
        report = wx.getStorageSync('CPTI_LAST_SOLO_REPORT') || null;
        if (report && app && app.globalData) {
          app.globalData.soloResult = report;
        }
      } catch (e) {}
    }

    if (isPair && !report && roomCode) {
      wx.showLoading({ title: '加载双人报告...' });
      const room = await getRoom(roomCode);
      wx.hideLoading();
      if (room && (room.status === 'ready' || (room.aSubmitted && room.bSubmitted))) {
        report = evaluateReport('pair', room.rawA, room.rawB);
        if (app && app.globalData) {
          app.globalData.pairRoom = room;
          app.globalData.pairResult = report;
        }
      } else if (room) {
        const active = getActiveRoom();
        const seat = active && active.roomCode === roomCode ? active.seat : 'B';
        wx.redirectTo({
          url: `/pages/room/room?roomCode=${encodeURIComponent(roomCode)}&seat=${seat}`
        });
        return;
      }
    }

    if (!report) {
      wx.showToast({ title: '报告已过期，请重新测评', icon: 'none' });
      setTimeout(() => {
        wx.reLaunch({ url: '/pages/index/index' });
      }, 600);
      return;
    }

    const characterImg = getCharacterImage(isPair ? 'pair' : 'solo', report.code);
    const aiEnabled = !!(app && app.globalData && app.globalData.aiConfig && app.globalData.aiConfig.enabled);
    const radarLegend = (report.axisSummary || []).map(a => ({ key: a.key, name: a.name, color: a.color }));

    this.setData({
      report,
      roomCode,
      characterImg,
      radarLegend,
      artLoadError: false,
      aiEnabled
    }, () => {
      this.drawRadar();
    });
  },

  drawRadar() {
    const traits = this.data.report && this.data.report.subTraits;
    if (!traits || traits.length !== 8) return;

    wx.createSelectorQuery().select('.radar-canvas').boundingClientRect((rect) => {
      if (!rect || !rect.width || !rect.height) return;
      const ctx = wx.createCanvasContext('subRadar', this);
      const w = rect.width;
      const h = rect.height;
      const cx = w / 2;
      const cy = h / 2 + 6;
      const radius = Math.min(w, h) / 2 - 70;
      const angleAt = i => -Math.PI / 2 + i * Math.PI / 4;
      const pointAt = (i, r) => ({
        x: cx + Math.cos(angleAt(i)) * r,
        y: cy + Math.sin(angleAt(i)) * r
      });

      ctx.clearRect(0, 0, w, h);

      ctx.setLineWidth(1);
      for (let ring = 1; ring <= 4; ring++) {
        ctx.setStrokeStyle(ring === 4 ? '#D1D5DB' : '#E5E7EB');
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const p = pointAt(i, radius * ring / 4);
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
        ctx.stroke();
      }

      ctx.setStrokeStyle('#EEF1F5');
      for (let i = 0; i < 8; i++) {
        const p = pointAt(i, radius);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }

      ctx.beginPath();
      traits.forEach((item, i) => {
        const p = pointAt(i, radius * Math.max(8, Math.min(100, item.score)) / 100);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.setFillStyle('rgba(51, 164, 116, 0.20)');
      ctx.fill();
      ctx.setStrokeStyle('#33A474');
      ctx.setLineWidth(2);
      ctx.stroke();

      traits.forEach((item, i) => {
        const p = pointAt(i, radius * Math.max(8, Math.min(100, item.score)) / 100);
        ctx.beginPath();
        ctx.arc(p.x, p.y, item.split ? 5 : 4, 0, Math.PI * 2);
        ctx.setFillStyle(item.split ? '#FFFFFF' : item.color);
        ctx.fill();
        ctx.setStrokeStyle(item.color);
        ctx.setLineWidth(2);
        ctx.stroke();

        const lp = pointAt(i, radius + 24);
        const cos = Math.cos(angleAt(i));
        const sin = Math.sin(angleAt(i));
        ctx.setFontSize(10);
        ctx.setFillStyle(item.split ? '#B45309' : '#6B7280');
        ctx.setTextAlign(cos > 0.25 ? 'left' : cos < -0.25 ? 'right' : 'center');
        ctx.setTextBaseline(sin > 0.35 ? 'top' : sin < -0.35 ? 'bottom' : 'middle');
        ctx.fillText(item.shortName || item.name, lp.x, lp.y);
      });

      ctx.draw();
    }).exec();
  },

  onArtError() {
    this.setData({ artLoadError: true });
  },

  async generateAiInsight() {
    const app = getApp();
    if (!wx.cloud || !wx.cloud.extend || !wx.cloud.extend.AI) {
      wx.showToast({ title: '需先开通云开发 AI+ 扩展能力', icon: 'none' });
      return;
    }
    this.setData({ aiLoading: true });
    try {
      const r = this.data.report;
      const model = wx.cloud.extend.AI.createModel('hunyuan-exp');
      const prompt = `你是亲密关系沟通顾问。用户测出的 CPTI 角色是「${r.title}（${r.code}）」，一句话特征：${r.oneLiner}。短板：${r.cons}。请用 120 字以内给出一段接地气、有画面感的具体对话示范建议。`;
      const res = await model.generateText({
        model: (app && app.globalData && app.globalData.aiConfig && app.globalData.aiConfig.model) || 'hunyuan-lite',
        messages: [{ role: 'user', content: prompt }]
      });
      this.setData({
        aiInsight: res.text || '建议在情绪上头前先约定 5 分钟冷静暗号。',
        aiLoading: false
      });
    } catch (e) {
      this.setData({ aiLoading: false });
      wx.showToast({ title: 'AI 解读生成失败，请稍后重试', icon: 'none' });
    }
  },

  retestSameMode() {
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.pairResult = null;
      app.globalData.pairRoom = null;
    }
    clearActiveRoom();
    if (this.data.report && this.data.report.isPair) {
      wx.redirectTo({ url: '/pages/room/room' });
    } else {
      wx.redirectTo({ url: '/pages/quiz/quiz?mode=solo' });
    }
  },

  goHome() {
    wx.reLaunch({ url: '/pages/index/index' });
  },

  onShareAppMessage() {
    const r = this.data.report;
    const isPair = r && r.isPair;
    const code = this.data.roomCode;
    if (isPair && r && code) {
      return {
        title: `我们的 CPTI 双人合盘结果是「${r.title}（${r.code}）」：${r.oneLiner}`,
        path: `/pages/report/report?mode=pair&roomCode=${encodeURIComponent(code)}`,
        imageUrl: SHARE_IMAGE
      };
    }
    return {
      title: r
        ? `我的 CPTI 恋爱人格是「${r.title}（${r.code}）」：${r.oneLiner}`
        : 'CPTI 恋爱人格测验｜测测你在亲密关系里的真实角色',
      path: '/pages/index/index',
      imageUrl: SHARE_IMAGE
    };
  }
});
