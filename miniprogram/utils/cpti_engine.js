const {
  AXIS_META,
  QUESTIONS,
  CORE_TYPE_MAP,
  SOLO_MATCH_MAP,
  OPEN_PROFILES
} = require('./cpti_data');

const TOTAL_QUESTIONS = 16;

function createEmptyRaw() {
  return new Array(TOTAL_QUESTIONS).fill(null);
}

/**
 * 归一化单题作答：
 * null / 'UNASKED' -> null（未问或未答）
 * 'SKIP' -> 'SKIP'（用户主动跳过）
 * -2..2 -> 数值分
 */
function normalizeAnswer(val) {
  if (val === null || val === undefined || val === 'UNASKED') return null;
  if (val === 'SKIP') return 'SKIP';
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

/**
 * 自适应追问判断：四主轴前两题若已有明确同向倾向，跳过第 3 题决胜追问；
 * 仅当前两题存在矛盾、包含 0（看情况）或包含 SKIP 时触发第 3 题。
 */
function shouldAskQuestion(index, rawAnswers) {
  const q = QUESTIONS[index];
  if (!q) return false;
  if (!q.isFollowup) return true;

  const baseStart = q.axis * 3;
  const v1 = normalizeAnswer(rawAnswers[baseStart]);
  const v2 = normalizeAnswer(rawAnswers[baseStart + 1]);
  if (v1 === null || v2 === null) return true;
  if (v1 === 'SKIP' || v2 === 'SKIP' || v1 === 0 || v2 === 0) return true;

  const s1 = v1 * QUESTIONS[baseStart].dir;
  const s2 = v2 * QUESTIONS[baseStart + 1].dir;
  return !((s1 > 0 && s2 > 0) || (s1 < 0 && s2 < 0));
}

function getNextQuestionIndex(currentIndex, rawAnswers) {
  for (let i = currentIndex + 1; i < TOTAL_QUESTIONS; i++) {
    if (shouldAskQuestion(i, rawAnswers)) return i;
  }
  return -1;
}

function getPrevQuestionIndex(currentIndex, rawAnswers) {
  for (let i = currentIndex - 1; i >= 0; i--) {
    if (shouldAskQuestion(i, rawAnswers)) return i;
  }
  return -1;
}

function getVisibleProgress(currentIndex, rawAnswers) {
  let total = 0;
  let current = 1;
  for (let i = 0; i < TOTAL_QUESTIONS; i++) {
    if (shouldAskQuestion(i, rawAnswers)) {
      total++;
      if (i === currentIndex) current = total;
    }
  }
  return { current, total: Math.max(total, 1) };
}

/**
 * 单人答卷解析
 */
function parseSheet(rawAnswers) {
  const axes = [[], [], [], []];
  const extraAxes = { 4: [], 5: [] };
  let answeredCount = 0;
  let skipCount = 0;
  let neutralCount = 0;

  QUESTIONS.forEach((q, idx) => {
    const val = normalizeAnswer(rawAnswers[idx]);
    if (val === null) return;
    if (val === 'SKIP') {
      skipCount++;
      return;
    }
    answeredCount++;
    if (val === 0) neutralCount++;
    const directed = val * q.dir;
    if (q.axis <= 3) {
      axes[q.axis].push(directed);
    } else {
      extraAxes[q.axis].push(directed);
    }
  });

  return {
    axes,
    extraAxes,
    answeredCount,
    skipCount,
    neutralCount
  };
}

/**
 * 纯净加权净分判定（确保与百分比滑轨 100% 同源，绝无 X 与 >50% 矛盾）
 */
function direction(axisValues) {
  if (!axisValues || axisValues.length === 0) return 'X';
  const sum = axisValues.reduce((acc, v) => acc + v, 0);
  if (sum > 0) return '+';
  if (sum < 0) return '-';
  return 'X';
}

function computeAxisPercent(axisValues) {
  if (!axisValues || axisValues.length === 0) return 50;
  const sum = axisValues.reduce((acc, v) => acc + v, 0);
  const maxPossible = axisValues.length * 2;
  const pct = Math.round(50 + (sum / maxPossible) * 42);
  return Math.max(8, Math.min(92, pct));
}

function computeExtraScore(values, fallbackScore) {
  if (!values || values.length === 0) return fallbackScore;
  const sum = values.reduce((acc, v) => acc + v, 0);
  const maxPossible = values.length * 2;
  const pct = Math.round(50 + (sum / maxPossible) * 45);
  return Math.max(5, Math.min(98, pct));
}

function buildAxisSummary(sheets) {
  return AXIS_META.map((meta, idx) => {
    if (sheets.length === 1) {
      const vals = sheets[0].axes[idx];
      const dir = direction(vals);
      const pct = computeAxisPercent(vals);
      return {
        ...meta,
        dir,
        letter: dir === '+' ? meta.posCode : dir === '-' ? meta.negCode : 'X',
        pct,
        split: false
      };
    }

    const dA = direction(sheets[0].axes[idx]);
    const dB = direction(sheets[1].axes[idx]);
    const pA = computeAxisPercent(sheets[0].axes[idx]);
    const pB = computeAxisPercent(sheets[1].axes[idx]);

    if ((dA === '+' && dB === '-') || (dA === '-' && dB === '+')) {
      return {
        ...meta,
        dir: 'X',
        letter: 'X',
        pct: 50,
        pctA: pA,
        pctB: pB,
        split: true
      };
    }

    const combined = [...sheets[0].axes[idx], ...sheets[1].axes[idx]];
    const dir = direction(combined);
    const pct = computeAxisPercent(combined);
    return {
      ...meta,
      dir,
      letter: dir === '+' ? meta.posCode : dir === '-' ? meta.negCode : 'X',
      pct,
      pctA: pA,
      pctB: pB,
      split: false
    };
  });
}

const SHORT_TRAIT_NAMES = {
  '情绪优先倾听': '情绪倾听',
  '先问需求再支招': '需求支招',
  '尊重独处边界': '尊重独处',
  '克制过度介入': '克制介入',
  '冲突及时复盘': '及时复盘',
  '不翻历史旧账': '不翻旧账',
  '约定准点履约': '准点履约',
  '变动提前同步': '变动同步'
};

function buildSubTraits(axisSummary) {
  const list = [];
  axisSummary.forEach((ax) => {
    const base = ax.split ? 50 : ax.pct;
    const delta = ax.split ? 0 : Math.round((base - 50) * 0.14);
    list.push({
      name: ax.subTraits[0],
      shortName: SHORT_TRAIT_NAMES[ax.subTraits[0]] || ax.subTraits[0],
      score: Math.max(8, Math.min(94, base + delta)),
      color: ax.color,
      split: ax.split
    });
    list.push({
      name: ax.subTraits[1],
      shortName: SHORT_TRAIT_NAMES[ax.subTraits[1]] || ax.subTraits[1],
      score: Math.max(8, Math.min(94, base - delta)),
      color: ax.color,
      split: ax.split
    });
  });
  return list;
}

function buildPlainTraitSummary(axisSummary, isPair) {
  const lines = [];
  const [r, b, f, k] = axisSummary;

  if (r.split) {
    lines.push({ title: '回应方式 · 存在温差', text: '你们一个习惯先哄情绪，另一个本能先给解决办法，吵架时容易一个嫌冷漠、一个嫌不理智。' });
  } else if (r.letter === 'R') {
    lines.push({ title: '回应方式 · 先接情绪', text: isPair ? '遇到烦心事你们懂得先托住彼此的情绪，确认被理解后再一起想办法。' : '对方倾诉时你习惯先安抚心情再给建议，很懂得提供情绪价值。' });
  } else if (r.letter === 'M') {
    lines.push({ title: '回应方式 · 优先排障', text: isPair ? '你们沟通直接高效，遇到问题更习惯快速拆解原因并拿出解决方案。' : '你习惯把烦恼当成待解决的任务，虽然少点甜言蜜语但行动力很扎实。' });
  } else {
    lines.push({ title: '回应方式 · 弹性切换', text: '你们不会死守一种聊天模式，而是看具体场合决定先安抚还是先支招。' });
  }

  if (b.split) {
    lines.push({ title: '边界方式 · 存在温差', text: '一个渴望粘在一起互相参与，另一个需要独立留白喘口气，亲密距离需要提前对齐。' });
  } else if (b.letter === 'B') {
    lines.push({ title: '边界方式 · 留白透气', text: isPair ? '你们尊重彼此的独处和社交空间，不查岗也不强行替对方拿主意。' : '你给足伴侣独立呼吸的空间，不爱打着「为你好」的旗号越界控制。' });
  } else if (b.letter === 'P') {
    lines.push({ title: '边界方式 · 介入操心', text: isPair ? '你们习惯深度参与彼此的日常细节，关心浓度高，但偶尔容易管得太宽。' : '爱一个人时你忍不住全方位操心规划，热忱满分但偶尔容易压缩对方空间。' });
  } else {
    lines.push({ title: '边界方式 · 适度陪伴', text: '你们在亲密黏合与个人空间之间保持着动态平衡，不会太疏离也不至于窒息。' });
  }

  if (f.split) {
    lines.push({ title: '修复速度 · 存在温差', text: '一个闹完别扭想当天清零，另一个需要时间体面冷存，冲突后容易出现时差。' });
  } else if (f.letter === 'F') {
    lines.push({ title: '修复速度 · 当场清零', text: isPair ? '拌嘴后你们愿意把卡住的点聊开翻篇，不把陈年旧账带进下一次生活。' : '你讨厌冷战拖延，闹别扭冷静后愿意主动沟通翻篇，不翻陈年旧账。' });
  } else if (f.letter === 'H') {
    lines.push({ title: '修复速度 · 体面冷存', text: isPair ? '表面和好很快，但真实委屈容易被悄悄存进心里，需要更坦诚的出口。' : '为了维持体面气氛你常选择「算了不说了」，但委屈容易在心里悄悄存档。' });
  } else {
    lines.push({ title: '修复速度 · 视事而定', text: '小摩擦你们能很快翻篇，遇到原则性分歧则会花时间慢慢消化复盘。' });
  }

  if (k.split) {
    lines.push({ title: '兑现可靠 · 存在温差', text: '一个把约定当准点军令状，另一个把计划当弹性参考线，履约节奏有落差。' });
  } else if (k.letter === 'K') {
    lines.push({ title: '兑现可靠 · 落地有声', text: isPair ? '答应彼此的大小事基本件件有回音，这种稳稳的确定感是关系最好的定心丸。' : '你很看重信用与准时，答应过的小事也记在心上，万一有变也会提前报备。' });
  } else if (k.letter === 'D') {
    lines.push({ title: '兑现可靠 · 弹性改签', text: isPair ? '你们的日常计划随性灵活，经常临时调整，虽有松弛感但也容易积累小失望。' : '你习惯随状态灵活调整计划，相处松弛不刻板，但偶尔容易让对方觉得不够准点。' });
  } else {
    lines.push({ title: '兑现可靠 · 随缘落地', text: '重要大事你们会认真履约，日常小约定则保留了灵活变通的余地。' });
  }

  return lines;
}

/**
 * 六维需求解析（尊重自由、安全感、陪伴、物质现实、浪漫新鲜感、情绪价值）
 * 物质现实 & 浪漫新鲜感由 Q13-Q16 直测支撑，双人自动标出温差
 */
function buildSixNeeds(sheets, axisSummary) {
  const [r, b, f, k] = axisSummary;
  const freedom = b.pct;
  const security = Math.round(k.pct * 0.65 + f.pct * 0.35);
  const emotion = Math.round(r.pct * 0.7 + f.pct * 0.3);
  const company = Math.round((100 - b.pct) * 0.55 + r.pct * 0.45);

  const matA = computeExtraScore(sheets[0].extraAxes[4], k.pct);
  const romA = computeExtraScore(sheets[0].extraAxes[5], Math.max(15, 100 - k.pct));

  let material = matA;
  let romance = romA;
  let matGap = false;
  let romGap = false;

  if (sheets.length === 2) {
    const matB = computeExtraScore(sheets[1].extraAxes[4], k.pct);
    const romB = computeExtraScore(sheets[1].extraAxes[5], Math.max(15, 100 - k.pct));
    material = Math.round((matA + matB) / 2);
    romance = Math.round((romA + romB) / 2);
    matGap = Math.abs(matA - matB) >= 35;
    romGap = Math.abs(romA - romB) >= 35;
  }

  const items = [
    {
      key: 'freedom',
      name: '尊重自由',
      score: freedom,
      color: '#33A474',
      hasGap: b.split,
      desc: freedom >= 65
        ? '亲密时仍能保有朋友、兴趣和独处的时间，对你很重要。自己的决定被尊重时，你也更愿意把真实的生活分享给对方。'
        : freedom >= 42
          ? '你希望既有共享时光，也保留各自的喘息空间；提前打好招呼的独处，最能让你感到安心自在。'
          : '你更喜欢高浓度的参与和陪伴，彼此生活交集越深、大小事一起商量，越能让你感受到被在乎。'
    },
    {
      key: 'security',
      name: '安全感',
      score: security,
      color: '#C0566A',
      hasGap: k.split || f.split,
      desc: security >= 65
        ? '态度明确、约定有下文，会让你更愿意投入。比起反复确认对方的心意，你更想在一件件小事里感到对方靠得住。'
        : security >= 42
          ? '你对计划保留适度包容，但关键节点希望得到及时同步；遇到分歧能坦诚聊开，安全感就会稳稳回升。'
          : '你不喜欢被条条框框的承诺绑住，当下的相处松弛感和心情契合度，比长期计划更能让你感到自在。'
    },
    {
      key: 'company',
      name: '陪伴',
      score: company,
      color: '#B87A3D',
      hasGap: b.split || r.split,
      desc: company >= 65
        ? '你希望日常能有一些固定的相处时间。各自忙完还能坐下来聊聊，比时时刻刻待在一起更适合你的节奏。'
        : company >= 42
          ? '你更看重相处时的专注质量而非时长，哪怕每天只有二十分钟专心聊天，也胜过各刷各的手机。'
          : '你享受低打扰的并肩陪伴，各自做着喜欢的事、偶尔抬头看一眼彼此，就是最舒服的状态。'
    },
    {
      key: 'material',
      name: '物质现实',
      score: material,
      color: '#4298B4',
      hasGap: matGap,
      desc: material >= 65
        ? '你很看重共同储蓄、消费习惯对齐以及抗风险规划。把现实账算清楚、对未来有共同盘算，会让你更踏实地投入感情。'
        : material >= 42
          ? '你愿意给计划留些弹性，也在意商量好的事有人负责。生活遇到变动时，彼此愿意重新谈一谈，比一开始就安排得很满更重要。'
          : '比起精打细算，你更看重当下的快乐体验与精神共鸣，觉得只要感情到位，现实问题总能一步步解决。'
    },
    {
      key: 'romance',
      name: '浪漫新鲜感',
      score: romance,
      color: '#B85D6F',
      hasGap: romGap,
      desc: romance >= 65
        ? '仪式感和一起解锁新体验对你来说不是点缀，而是爱情的保鲜剂。偶尔的突发奇想和小惊喜，能瞬间点亮你的投入度。'
        : romance >= 42
          ? '你喜欢生活保有熟悉的节奏，偶尔也想一起换条路走。小惊喜恰好碰上你在意的细节时，往往比盛大的安排更让你记得。'
          : '你偏爱踏实可预期的安稳日常，比起刻意制造的大起大落，细水长流的陪伴更合你的胃口。'
    },
    {
      key: 'emotion',
      name: '情绪价值',
      score: emotion,
      color: '#88619A',
      hasGap: r.split,
      desc: emotion >= 65
        ? '被听见、被偏爱、情绪有人接住，是你亲密关系里的核心养分。哪怕问题暂时没解决，一句「我懂你的委屈」也能让你瞬间满血。'
        : emotion >= 42
          ? '你既需要适度的情绪安抚，也看重实际行动支持；先给个抱抱再一起想办法，最容易戳中你的心坎。'
          : '情绪不太好的时候，你有时会先自己缓一缓。想说话时，一句简单的关心或一个愿意等你的动作也能带来支持。'
    }
  ];

  return items.sort((a, bItem) => bItem.score - a.score);
}

/**
 * 综合判定：返回称号、四位代码、完整报告数据
 */
function evaluateReport(mode, rawA, rawB = null, options = {}) {
  const isPair = mode === 'pair';
  const sheetA = parseSheet(rawA);
  const sheets = isPair ? [sheetA, parseSheet(rawB || createEmptyRaw())] : [sheetA];
  const axisSummary = buildAxisSummary(sheets);
  const code = axisSummary.map(a => a.letter).join('');

  const totalAnswered = sheets.reduce((s, sh) => s + sh.answeredCount, 0);
  const totalNeutral = sheets.reduce((s, sh) => s + sh.neutralCount, 0);
  const isPreview = !isPair && options.experienceSource === 'imagination';

  let title = '';
  let profile = null;

  if (totalAnswered < 4) {
    title = isPair ? '双人空白卡' : '留白玩家';
    profile = OPEN_PROFILES[title];
  } else if (!code.includes('X') && CORE_TYPE_MAP[code]) {
    profile = CORE_TYPE_MAP[code];
    const baseTitle = isPair ? profile.pairTitle : profile.soloTitle;
    title = isPreview ? `恋爱预演 · ${baseTitle}` : baseTitle;
  } else if (code === 'XXXX') {
    const splitCount = axisSummary.filter(a => a.split).length;
    if (isPair && splitCount >= 3) {
      title = '错频搭子';
    } else if (totalNeutral >= totalAnswered * 0.5) {
      title = isPair ? '百搭双排' : (isPreview ? '恋爱云玩家' : '都可仙人');
    } else {
      title = isPair ? '情境搭子' : '看菜下筷';
    }
    profile = OPEN_PROFILES[title];
  } else {
    // 含部分 X 的开放型归类
    const splitIdx = axisSummary.findIndex(a => a.split);
    if (isPair && splitIdx !== -1) {
      const splitNames = ['错频搭子', '边界温差', '单方待机', '时差搭子'];
      title = splitNames[splitIdx];
    } else if (!isPair && axisSummary[0].letter !== 'X' && axisSummary[1].letter === 'X' && axisSummary[2].letter === 'X') {
      title = '接话侠';
    } else if (!isPair && axisSummary[2].letter !== 'X' && axisSummary[0].letter === 'X' && axisSummary[1].letter === 'X') {
      title = '补锅侠';
    } else if (!isPair && axisSummary[1].letter !== 'X' && axisSummary[0].letter === 'X' && axisSummary[2].letter === 'X') {
      title = '刹车练习生';
    } else if (!isPair && axisSummary[3].letter === 'D' && axisSummary[0].letter === 'X') {
      title = '改签高手';
    } else {
      title = isPreview ? '恋爱预演 · 未定式玩家' : '未定式玩家';
    }
    profile = OPEN_PROFILES[title] || OPEN_PROFILES['未定式玩家'];
  }

  const subTraits = buildSubTraits(axisSummary);
  const plainTraits = buildPlainTraitSummary(axisSummary, isPair);
  const sixNeeds = buildSixNeeds(sheets, axisSummary);
  const matches = !isPair ? (SOLO_MATCH_MAP[code] || SOLO_MATCH_MAP['RBFK']) : [];

  return {
    mode,
    isPair,
    isPreview,
    code,
    title,
    group: profile.group,
    color: profile.color,
    oneLiner: isPair ? (profile.pairOne || profile.one) : (profile.soloOne || profile.one),
    traitIntro: isPair ? (profile.pairTrait || profile.trait) : (profile.soloTrait || profile.trait),
    pros: profile.pros,
    cons: profile.cons,
    plan: profile.plan,
    axisSummary,
    subTraits,
    plainTraits,
    sixNeeds,
    matches
  };
}

module.exports = {
  TOTAL_QUESTIONS,
  createEmptyRaw,
  shouldAskQuestion,
  getNextQuestionIndex,
  getPrevQuestionIndex,
  getVisibleProgress,
  evaluateReport
};
