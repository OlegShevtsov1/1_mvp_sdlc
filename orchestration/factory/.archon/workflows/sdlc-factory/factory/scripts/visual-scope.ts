import { emit } from "./_lib/io.ts";
import { visualScope } from "./_lib/visual.ts";

// Binding: task ($INPUTS.task) and request ($ARGUMENTS). Pure parsing of the task text: whether
// the task is visual (PILOT-278), its visual reference, and the brief the work orders append.
emit(visualScope(process.env.INPUTS_TASK ?? "", process.env.INPUTS_REQUEST ?? ""));
