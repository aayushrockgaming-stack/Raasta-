"use strict";

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "missions.json");
let missions = [];
let stops = [];

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
    missions = Array.isArray(saved.missions) ? saved.missions : [];
    stops = Array.isArray(saved.stops) ? saved.stops : [];
  } catch {
    missions = [];
    stops = [];
  }
}
load();

function persist() {
  fs.writeFile(FILE, JSON.stringify({ missions, stops }), (error) => {
    if (error) console.warn("missionsStore: write failed:", error.message);
  });
}

function createMission(mission, missionStops = []) {
  missions.unshift(mission);
  stops.push(...missionStops);
  persist();
  return { mission, stops: missionStops };
}

function listMissions(limit = 50) {
  return missions.slice(0, limit).map((mission) => ({
    mission,
    stops: stops.filter((stop) => stop.mission_id === mission.id).sort((a, b) => a.sequence - b.sequence)
  }));
}

function updateMission(id, patch) {
  const mission = missions.find((item) => item.id === id);
  if (!mission) return null;
  Object.assign(mission, patch);
  persist();
  return mission;
}

function updateStop(id, patch) {
  const stop = stops.find((item) => item.id === id);
  if (!stop) return null;
  Object.assign(stop, patch);
  persist();
  return stop;
}

module.exports = { createMission, listMissions, updateMission, updateStop };
