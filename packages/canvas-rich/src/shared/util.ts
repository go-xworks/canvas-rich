/**
 * 跨层纯工具集（对标 `@vue/shared` / Next `lib/`）。
 *
 * 本模块位于依赖分层的最底层：`model/ text/ render/ ui/` 可自由复用，
 * 但本模块**不得**反向 import 任何上层。仅放置无副作用、与领域无关的小工具。
 * @internal
 */

/**
 * 把数值夹到闭区间 `[lo, hi]`。
 *
 * 前置：调用方保证 `lo <= hi`（本仓所有调用点均满足，如 `clamp(x, 0, count-1)`）；
 * 若 `lo > hi` 则返回 `lo`（先与下界比较）。`NaN` 透传不夹（比较恒为 false）。
 * 全仓最高频的边界守卫：位置 clamp、列/行号 clamp、尺寸 clamp 共用。
 * @param v - 待夹的值
 * @param lo - 下界（含）
 * @param hi - 上界（含）
 * @returns `v < lo ? lo : v > hi ? hi : v`
 * @public
 */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 在**升序**数组里二分查找：返回满足 `arr[k] <= target` 的最大下标 `k`（找不到则 0）。
 * 用于「偏移 → 区段下标」「视觉 x → 字符列」这类有序映射。
 * @public
 */
export function lowerBoundIndex(arr: ArrayLike<number>, target: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
