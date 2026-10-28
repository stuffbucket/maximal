import { describe, expect, test } from "bun:test"

import { SeriesColors } from "../shell/src/dashboard/live/colors"

const ids = (n: number): Array<string> =>
  Array.from({ length: n }, (_, i) => `s${i + 1}`)

describe("SeriesColors", () => {
  test("seven live sessions get slots 1 to 6 and one neutral", () => {
    const colors = new SeriesColors().assign(ids(7))
    expect([...colors.entries()]).toEqual([
      ["s1", 1],
      ["s2", 2],
      ["s3", 3],
      ["s4", 4],
      ["s5", 5],
      ["s6", 6],
      ["s7", null],
    ])
  })

  test("surviving sessions keep their slots across calls, whatever the order", () => {
    const series = new SeriesColors()
    series.assign(["a", "b", "c"])
    const next = series.assign(["c", "a", "b"])
    expect(next.get("a")).toBe(1)
    expect(next.get("b")).toBe(2)
    expect(next.get("c")).toBe(3)
  })

  test("a session going cold frees its slot and a new one takes it", () => {
    const series = new SeriesColors()
    series.assign(["a", "b", "c"])
    const afterCold = series.assign(["a", "c"])
    expect(afterCold.has("b")).toBe(false)
    expect(afterCold.get("c")).toBe(3)
    const afterNew = series.assign(["a", "c", "d"])
    expect(afterNew.get("d")).toBe(2)
    expect(afterNew.get("c")).toBe(3)
  })

  test("a neutral seventh gets a color once a colored one goes cold", () => {
    const series = new SeriesColors()
    series.assign(ids(7))
    const next = series.assign(ids(7).filter((id) => id !== "s4"))
    expect(next.get("s7")).toBe(4)
    expect(next.get("s5")).toBe(5)
  })

  test("a session that comes back after going cold starts over", () => {
    const series = new SeriesColors()
    series.assign(["a", "b"])
    series.assign(["b"])
    expect(series.assign(["c", "b", "a"]).get("a")).toBe(3)
  })
})
