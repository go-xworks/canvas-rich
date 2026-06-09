/**
 * 跨层纯工具集（对标 `@vue/shared` / Next `lib/`）。
 *
 * 本模块位于依赖分层的最底层：`model/ text/ render/ ui/` 可自由复用，
 * 但本模块**不得**反向 import 任何上层。仅放置无副作用、与领域无关的小工具。
 * @internal
 */

/** 空操作函数（占位回调，避免重复创建闭包）。 @internal */
export const NOOP = (): void => {};

/**
 * 把数值夹到闭区间 `[lo, hi]`。
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
