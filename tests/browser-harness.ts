import { db } from "../src/db";
import {
  applyObservation,
  createMission,
  setSource,
  candidatePage,
} from "../src/data";
import { exportBackup, restoreBackup } from "../src/backup";
import { runner } from "../src/runner";
(window as any).__testing = {
  db,
  applyObservation,
  createMission,
  setSource,
  candidatePage,
  exportBackup,
  restoreBackup,
  runner,
};
