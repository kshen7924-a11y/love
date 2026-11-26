App({
  globalData: {
    debug: true, // 开发版/体验版开启调试，正式版由环境判断自动关闭
    cloudEnvId: '', // 开通微信云开发后填入你的环境 ID（如 'cpti-prod-xxxx'），留空时自动降级本地演示联机
    cloudReady: false,
    soloDraft: null,
    soloResult: null,
    pairRoom: null,
    pairResult: null,
    adConfig: {
      enabled: false, // 流量主开通后改为 true
      rewardedVideoAdUnitId: '',
      interstitialAdUnitId: ''
    },
    aiConfig: {
      enabled: false, // 开启 wx.cloud.extend.AI 深度合盘后改为 true
      model: 'hunyuan-lite'
    }
  },

  onLaunch() {
    let envVersion = '';
    try {
      envVersion = (wx.getAccountInfoSync && wx.getAccountInfoSync().miniProgram.envVersion) || '';
    } catch (e) {}
    const allowDebug = this.globalData.debug
      && (!envVersion || envVersion === 'develop' || envVersion === 'trial');
    if (allowDebug && wx.setEnableDebug) {
      wx.setEnableDebug({ enableDebug: true });
      console.log('[CPTI] 开发者调试模式已开启');
    }
    if (wx.cloud && this.globalData.cloudEnvId) {
      try {
        wx.cloud.init({
          env: this.globalData.cloudEnvId,
          traceUser: true
        });
        this.globalData.cloudReady = true;
      } catch (err) {
        console.warn('[CPTI] 云开发初始化降级到本地模式:', err);
        this.globalData.cloudReady = false;
      }
    }
  }
});
