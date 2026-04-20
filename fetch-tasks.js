"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = require("./src/db");
async function fetchTasks() {
    const { data, error } = await db_1.db
        .from('trinity_tasks')
        .select('*')
        .eq('status', 'pending')
        .order('priority', { ascending: true });
    if (error) {
        console.error("Error fetching tasks:", error.message);
    }
    else {
        console.log(JSON.stringify(data, null, 2));
    }
}
fetchTasks();
//# sourceMappingURL=fetch-tasks.js.map