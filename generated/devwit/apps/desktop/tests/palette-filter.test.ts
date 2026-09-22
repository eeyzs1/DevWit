import { describe, expect, it } from "vitest";
import { filterPalette } from "../src/renderer/palette-filter.js";

const items = [
  { label: "打开文件夹", payload: 1 },
  { label: "保存文件", payload: 2 },
  { label: "切换到终端", payload: 3 },
  { label: "Toggle Terminal Panel", payload: 4 },
  { label: "src/main.ts", payload: 5 },
  { label: "src/renderer/index.ts", payload: 6 },
];

describe("filterPalette（模糊过滤）", () => {
  it("空查询返回前 limit 项（分数全 0 保持注册序）", () => {
    const out = filterPalette(items, "", 3);
    expect(out).toHaveLength(3);
    expect(out[0]?.label).toBe("打开文件夹");
  });

  it("子序列命中：'终' 命中「切换到终端」", () => {
    const out = filterPalette(items, "终");
    expect(out.some((item) => item.payload === 3)).toBe(true);
  });

  it("不命中过滤：'zzz' 无结果", () => {
    expect(filterPalette(items, "zzz")).toEqual([]);
  });

  it("连续命中排名高于离散命中", () => {
    // "main" 连续出现在 src/main.ts；构造一个离散命中对照
    const custom = [
      { label: "mxxaxixnxx", payload: 1 }, // 离散
      { label: "src/main.ts", payload: 2 }, // 连续
    ];
    const out = filterPalette(custom, "main");
    expect(out[0]?.payload).toBe(2);
  });

  it("词首命中加分：'tt' 命中 Toggle Terminal 的双词首", () => {
    const custom = [
      { label: "letter", payload: 1 },      // l-e-t-t-e-r：tt 在词中
      { label: "Toggle Terminal", payload: 2 }, // 双词首
    ];
    const out = filterPalette(custom, "tt");
    expect(out[0]?.payload).toBe(2);
  });

  it("大小写不敏感", () => {
    const out = filterPalette(items, "TERMINAL");
    expect(out.some((item) => item.payload === 4)).toBe(true);
  });

  it("路径过滤：'idx' 命中 index 文件", () => {
    const out = filterPalette(items, "idx");
    expect(out.some((item) => item.payload === 6)).toBe(true);
  });

  it("空格是宽松分隔（'src ts' 命中 .ts 文件）", () => {
    const out = filterPalette(items, "src ts");
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((item) => typeof item.payload === "number")).toBe(true);
  });

  it("limit 截断", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ label: `item-${i}`, payload: i }));
    expect(filterPalette(many, "", 10)).toHaveLength(10);
  });
});
