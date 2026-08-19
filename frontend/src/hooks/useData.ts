import { useCallback, useEffect, useState } from "react";
import * as db from "../lib/db";
import type { Class, Task, TaskStatus } from "../lib/types";

function message(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String(e.message);
  return "Something went wrong";
}

/**
 * Classes and tasks are loaded together and refreshed together.
 *
 * They are small — a semester is maybe six classes and a few dozen live tasks
 * — and almost every view needs both, so a single shared load beats two
 * independently-staleable caches. Still no react-query: the board needs
 * exactly one optimistic write (a drag), and `moveTask` below is it.
 */
export function useData(userId: string) {
  const [classes, setClasses] = useState<Class[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      // Sweep first, so the load that follows already excludes anything that
      // just aged out. Doing it the other way round shows a card for one
      // render and then vanishes it.
      await db.archiveCompleted();
      const [c, t] = await Promise.all([db.listClasses(true), db.listTasks()]);
      setClasses(c);
      setTasks(t);
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Drag a card to another column.
   *
   * Optimistic, and deliberately so: a drag is a direct-manipulation gesture,
   * and a card that springs back to the old column for 200ms while a round
   * trip lands reads as the app fighting you. On failure the previous state
   * goes back and the error is surfaced — no silent divergence between what
   * the screen shows and what the database holds.
   *
   * No refresh() afterwards. The one authoritative field the server decides
   * is completed_at, and the returned row carries it.
   */
  const moveTask = useCallback(
    async (task: Task, status: TaskStatus, position?: number) => {
      const previous = tasks;
      setTasks((prev) =>
        prev.map((t) => (t.id === task.id ? { ...t, status } : t)),
      );
      try {
        const saved = await db.moveTask(task, status, position);
        setTasks((prev) => prev.map((t) => (t.id === task.id ? saved : t)));
      } catch (e) {
        setTasks(previous);
        setError(message(e));
      }
    },
    [tasks],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // setClasses/setTasks are exposed for one purpose: the undo path. A
  // destructive action takes the row off the screen straight away and holds
  // the delete for a few seconds (see lib/toast), so the component doing it
  // needs to be able to put the row back without a round trip. Ordinary
  // writes still go through db.* and refresh().
  return {
    classes,
    tasks,
    loading,
    error,
    refresh,
    moveTask,
    setError,
    setClasses,
    setTasks,
    userId,
  };
}

export type DataStore = ReturnType<typeof useData>;
