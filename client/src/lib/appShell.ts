import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/**
 * The assembled app, shared by every page.
 *
 * One query key so the whole client agrees on which blocks this athlete has —
 * a nav built from one copy of the answer and a page body built from another
 * is how you get a tab that leads to an empty screen.
 */
export function useAppShell() {
  return useQuery({ queryKey: ["app-shell"], queryFn: api.appShell, staleTime: 30_000 });
}

/** Block ids assembled onto a surface, in the order the assembler put them. */
export function useSurfaceBlocks(surface: string): string[] | undefined {
  const { data } = useAppShell();
  return data?.surfaces.find((s) => s.id === surface)?.blocks.map((b) => b.id);
}

/**
 * Order and filter a page's sections by what the assembler picked.
 *
 * While the shell is still loading, `blocks` is undefined and everything
 * renders — a page that flashes empty on every load is worse than one that
 * briefly shows a section the athlete will lose.
 */
export function orderByBlocks<T extends { blockId: string }>(sections: T[], blocks: string[] | undefined): T[] {
  if (!blocks) return sections;
  return blocks.map((id) => sections.find((s) => s.blockId === id)).filter((s): s is T => Boolean(s));
}
