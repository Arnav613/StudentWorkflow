import { useCallback, useEffect, useState } from "react";
import * as db from "../lib/db";
import type { Class, Task } from "../lib/types";

function message(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String(e.message);
  return "Something went wrong";
}

/**
 * Classes and tasks are loaded together and refreshed together.
 *
 * They are small — a semester is maybe six classes and a few dozen live tasks
 * — and almost every view needs both, so a single shared load beats two
 * independently-staleable caches. No react-query yet; when the board needs
 * optimistic drag updates in phase 02, that is the moment to reach for it.
 */
export function useData(userId: string) {
  const [classes, setClasses] = useState<Class[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [c, t] = await Promise.all([db.listClasses(true), db.listTasks()]);
      setClasses(c);
      setTasks(t);
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { classes, tasks, loading, error, refresh, setError, userId };
}

export type DataStore = ReturnType<typeof useData>;
