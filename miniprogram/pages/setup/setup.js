const { PERSONALITY_META, STORAGE_KEYS } = require("../../utils/util");

Page({
  data: {
    personalities: Object.keys(PERSONALITY_META).map((key) => ({
      key,
      ...PERSONALITY_META[key],
    })),
    personality: "gentle",
    personalityMeta: PERSONALITY_META.gentle,
    name: "",
    canStart: false,
  },

  onLoad() {
    const name = wx.getStorageSync(STORAGE_KEYS.name) || "";
    this.setData({
      name,
      canStart: !!name,
      personalityMeta: PERSONALITY_META[this.data.personality],
    });
  },

  pickPersonality(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({
      personality: key,
      personalityMeta: PERSONALITY_META[key],
    });
  },

  onName(e) {
    this.setData({ name: e.detail.value, canStart: !!e.detail.value.trim() });
  },

  start() {
    const name = this.data.name.trim();
    if (!name) return;
    wx.setStorageSync(STORAGE_KEYS.name, name);
    wx.setStorageSync(STORAGE_KEYS.personality, this.data.personality);
    // 新人设：清空旧对话
    wx.removeStorageSync(STORAGE_KEYS.history);
    wx.removeStorageSync(STORAGE_KEYS.greeting);
    wx.reLaunch({ url: "/pages/chat/chat?fresh=1" });
  },
});
