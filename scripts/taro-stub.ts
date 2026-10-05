// 测试专用：用内存 Map 模拟 Taro 本地存储
export const mem = new Map<string, string>();

const Taro = {
  getStorageSync(key: string) {
    return mem.has(key) ? mem.get(key) : '';
  },
  setStorageSync(key: string, value: string) {
    mem.set(key, value);
  },
  clearStorage() {
    mem.clear();
  }
};

export default Taro;
