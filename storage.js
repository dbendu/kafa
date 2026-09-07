"use strict";

const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

const TABLES = { days: "visits", skips: "skips", fails: "fails" };
const sameName = (a, b) => a.toLocaleLowerCase("ru") === b.toLocaleLowerCase("ru");

class Storage {
  constructor(filename) {
    // A wrong path must not silently create an empty replacement database.
    if (!fs.existsSync(filename)) {
      throw new Error(`База ${filename} не найдена. Укажите существующую data.sqlite через DATA_FILE.`);
    }
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      for (const [table, columns] of Object.entries({
        people: "id, name", visits: "id, date, person_id", skips: "id, date, person_id",
        reasons: "id, reason", fails: "id, date, person_id, reason_id",
      })) {
        this.db.prepare(`SELECT ${columns} FROM ${table} LIMIT 0`).all();
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  transaction(fn, write = true) {
    this.db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  read() {
    return this.transaction(() => {
      const state = { days: {}, people: [], skips: {}, fails: {}, reasons: [], failDetails: {} };
      state.reasons = this.db.prepare("SELECT id, reason FROM reasons ORDER BY id").all()
        .filter(row => row.reason.trim());
      state.people = this.db.prepare("SELECT name FROM people ORDER BY id").all().map(p => p.name);
      for (const [kind, table] of Object.entries(TABLES)) {
        for (const row of this.db.prepare(`SELECT e.date, p.name FROM ${table} e
          JOIN people p ON p.id = e.person_id ORDER BY e.id`).all()) {
          (state[kind][row.date] ||= []).push(row.name);
        }
      }
      for (const row of this.db.prepare(`SELECT f.id, f.date, p.name, f.reason_id, r.reason
        FROM fails f JOIN people p ON p.id = f.person_id
        LEFT JOIN reasons r ON r.id = f.reason_id ORDER BY f.id`).all()) {
        const { date, ...detail } = row;
        (state.failDetails[date] ||= []).push(detail);
      }
      return state;
    }, false);
  }

  change(kind, date, name, remove = false, reasonId) {
    if (typeof name !== "string" || !name) throw new Error("Укажите одного человека");
    const table = TABLES[kind];
    if (!table) throw new Error("Неизвестный тип отметки");
    this.transaction(() => {
      const reason = kind === "fails" && !remove && Number.isSafeInteger(reasonId)
        ? this.db.prepare("SELECT reason FROM reasons WHERE id = ?").get(reasonId) : null;
      if (kind === "fails" && !remove && !reason?.reason.trim()) {
        const error = new Error("Выберите существующую причину косяка");
        error.statusCode = 400;
        throw error;
      }
      const people = this.db.prepare("SELECT id, name FROM people ORDER BY id").all();
      let matches = people.filter(p => sameName(p.name, name));
      if (!matches.length && !remove) {
        this.db.prepare("INSERT INTO people(name) VALUES (?)").run(name);
        const person = this.db.prepare("SELECT id, name FROM people WHERE name = ?").get(name);
        matches = [person];
      }
      if (remove) {
        for (const person of matches) {
          this.db.prepare(`DELETE FROM ${table} WHERE date = ? AND person_id = ?`).run(date, person.id);
        }
        return;
      }

      // Attendance and skipping exclude each other; fails remain independent.
      const opposite = kind === "days" ? "skips" : kind === "skips" ? "visits" : null;
      for (const person of matches) {
        if (opposite) this.db.prepare(`DELETE FROM ${opposite} WHERE date = ? AND person_id = ?`).run(date, person.id);
      }
      const exists = matches.some(p => this.db.prepare(
        `SELECT id FROM ${table} WHERE date = ? AND person_id = ? LIMIT 1`
      ).get(date, p.id));
      if (exists) return;

      if (kind === "fails") {
        this.db.prepare("INSERT INTO fails(date, person_id, reason_id) VALUES (?, ?, ?)")
          .run(date, matches[0].id, reasonId);
      } else {
        this.db.prepare(`INSERT INTO ${table}(date, person_id) VALUES (?, ?)`)
          .run(date, matches[0].id);
      }
    });
  }

  close() {
    this.db.close();
  }
}

module.exports = { Storage };
