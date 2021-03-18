const fs = require("fs");
const xml2js = require("xml2js");
const _ = require("lodash");
const path = require("path");
const os = require("os");
const isWin = process.platform === "win32";

const findVdjDatabase = (dir) => {
  if (isWin) {
    let volumeFolder = dir;
    while (volumeFolder !== path.win32.dirname(volumeFolder)) volumeFolder = path.win32.dirname(volumeFolder);
    return path.win32.join(volumeFolder,"VirtualDJ","database.xml");
  } else {
    return path.join(require('os').homedir(),"Documents","VirtualDJ","database.xml");
  }
}

async function* walk(dir) {
    for await (const d of await fs.promises.readdir(dir,{"withFileTypes":true})) {
        const entry = path.join(dir, d.name);
        if (d.isDirectory()) yield* walk(entry);
        else if (d.isFile()) yield entry;
    }
}

async function doExport(xml,dir) {
  const parsed = await xml2js.parseStringPromise(xml);
  const songs = parsed.VirtualDJ_Database.Song;
  const directorySongs = _.filter(songs,(s) => s.$.FilePath.startsWith(dir));
  const res = _.map(directorySongs,(s) => {
    const cues = _.filter(s.Poi,(p) => p.$.Type === "cue");
    return {
      "name":path.basename(s.$.FilePath),
      "path":s.$.FilePath,
      "size":s.$.FileSize,
      "cues":_.map(cues,"$")
    }
  });
  console.log(JSON.stringify(res, null, 2),"utf-8");
}

async function loadDatabase(f) {
  console.log("Loading Database: "+f);
  const xml = fs.readFileSync(f, "utf-8");
  return xml2js.parseStringPromise(xml);
}

async function saveDatabase(f,db) {
  const xml = new xml2js.Builder({
    renderOpts:{
      'pretty': true,
      'indent': ' ',
      'newline': '\r\n'
    },
    xmldec:{ 'version': '1.0', 'encoding': 'UTF-8', 'standalone': undefined  }
  }).buildObject(db).replace(/\/>/g," />").trim();

  fs.writeFileSync(f,xml,"utf-8");
}

async function doImport(xml,data,dir) {
  const parsed = await xml2js.parseStringPromise(xml);
  const songs = parsed.VirtualDJ_Database.Song;


  for (const song of data) {

    if (song.cues.length === 0) continue;
    if (nameAndSizeMatches.length || pathMatches.length) {


    }
    const newSong = {
      '$':{ FilePath:songPathByName },
      'Poi':_.map(song.cues,(c) => ({'$':c}))
    };
    parsed.VirtualDJ_Database.Song.push(newSong);
  }
}

async function loadMemo(jsonFile) {
  console.log("Loading memo: ",jsonFile);
  if (!fs.existsSync(jsonFile)) return [];
  const jsonRaw = fs.readFileSync(jsonFile, "utf-8");
  return JSON.parse(jsonRaw);
}

async function saveMemo(jsonFile,memo) {
  fs.writeFileSync(jsonFile,JSON.stringify(memo,null,2), "utf-8");
}

const firstFrom = (a) => a ? a[0] : null;

function mergeSongData(from_vdj,from_json) {
  if (!from_vdj) return from_json;
  if (!from_json) return from_vdj;
  const res = _.merge(from_vdj,from_json);
  res.$ = _.merge(from_vdj.$,from_json.$);
  res.Tags = [_.merge(firstFrom(from_vdj.Tags),firstFrom(from_json.Tags))];
  res.Infos = [_.merge(firstFrom(from_vdj.Infos),firstFrom(from_json.Infos))];
  res.Scan = [_.merge(firstFrom(from_vdj.Scan),firstFrom(from_json.Scan))];
  res.Poi = [...from_vdj.Poi || [],...from_json.Poi ||[]];
  //const filteredPoi = _.filter(from_json.Poi,(p) => p.$.Type === "cue" || p.$.Type === "loop");
  // console.log("from_vdj",_.filter(from_vdj.Poi,(p) => p.$.Type === "cue" || p.$.Type === "loop"))
  // console.log("from_json",_.filter(from_json.Poi,(p) => p.$.Type === "cue" || p.$.Type === "loop"))
  //const filteredPoiNames = _.map(filteredPoi,(p) => p.$.Name);
  //res.Poi = _.reject(res.Poi,p => p.$.Name && _.includes(filteredPoiNames,p.$.Name));
  //res.Poi = [...res.Poi,...filteredPoi];
  res.Poi = _.uniqBy(res.Poi,(p) => p.$.Name || p.$.Pos);

  const cues = new Set();
  for (p of res.Poi) {
    if (cues.has(p.$.Num)) delete p.$.Num;
    if (p.$.Num) cues.add(p.$.Num);
  }
  // console.log("res",_.filter(res.Poi,(p) => p.$.Type === "cue" || p.$.Type === "loop"))
  return res;
}

const songsMatch = (a,b) => a.$.FileSize === b.$.FileSize && path.basename(a.$.FilePath) === path.basename(b.$.FilePath);
const calculateMatchHash = (name,size) => `${size}_${name}`;
const isWindowsPath = (p) => p.indexOf("\\") !== -1;
const parsePath = (p) => isWindowsPath(p) ? path.win32.parse(p) : path.posix.parse(p);
const nameForPath = (p) => parsePath(p).base;

async function walkFilesystemForSongs(dir) {
  const songs = [];
  for await (const p of walk(dir)) {
    const o = path.parse(p);
    if (_.includes([".mp3",".mp4",".flac"],o.ext)) {
      const stat = await fs.promises.stat(p);
      songs.push({
        path:p,
        stat,
        hash:calculateMatchHash(o.base,stat.size),
      });
    }
  }
  return songs;
}

async function main() {
  const cwd = __dirname;
  const mode = process.argv[2] || "sync";
  const vdjPath = findVdjDatabase(cwd);
  const db = await loadDatabase(vdjPath);
  const memoPath = "memo.json";
  let memo = await loadMemo(memoPath);

  if (mode === "cleandb") {
    for (const song of memo) {
      const songPathByName = path.join(cwd,song.name);
      const clean = _.filter(db.VirtualDJ_Database.Song,(s) => {
        return path.basename(s.$.FilePath) === song.name && s.$.FileSize === song.size
          || s.$.FilePath === songPathByName;
      });

      console.log(`Cleaning: ${clean.length} entry(ies) for ${song.name}`);
      db.VirtualDJ_Database.Song = _.difference(db.VirtualDJ_Database.Song,clean);
    }
  } else if (mode === "import") {
    const xml = await doImport(vdj,json,cwd);
    fs.writeFileSync(vdjPath,xml,"utf-8");
  } else if (mode === "lib") {
    const importDatabasePath = process.argv[3];
    const localRoot = process.argv[4];

    const importDatabase = await loadDatabase(importDatabasePath);
    const filesystemSongs = walkFilesystemForSongs(localRoot);

    const dbByNameSize = {}
    for (const s of importDatabase.VirtualDJ_Database.Song) {

      const size = s.$.FileSize;
      const key = `${size}_${name}`;
      allKeys.add(key);
      dbByNameSize[key] = s;
    };
  } else if (mode === "sync") {
    const directorySongs = _.filter(db.VirtualDJ_Database.Song,(s) => s.$.FilePath.startsWith(cwd));
    if (_.uniqWith(directorySongs,(a,b) => songsMatch(a,b)).length != directorySongs.length) {
      console.log("duplicate songs, abort!");
      process.exit()
    }
    for (const from_vdj of directorySongs) {
      const from_json = _.find(memo,(s) => songsMatch(s,from_vdj));

      const updated = mergeSongData(from_vdj,from_json);
      memo = _.reject(memo,(s) => songsMatch(s,from_vdj));
      memo.push(updated);
    }

    for (const from_json of memo) {
      const from_vdj = _.find(db.VirtualDJ_Database.Song,(s) => songsMatch(s,from_json));
      if (from_vdj) {
        const updated = mergeSongData(from_vdj,from_json);
        db.VirtualDJ_Database.Song = _.reject(db.VirtualDJ_Database.Song,(s) => songsMatch(s,from_json));
        db.VirtualDJ_Database.Song.push(updated);
      } else {
        db.VirtualDJ_Database.Song.push(from_json);
      }
    }
  }

  saveDatabase(vdjPath,db);
  saveMemo(memoPath,memo);
}

function mergeDatabases(a,b) {
  const out = _.cloneDeep(a);
  const aByHash = _.keyBy(b.VirtualDJ_Database.Song,(s) => calculateMatchHash(nameForPath(s.$.FilePath),s.$.FileSize));
  const bByHash = _.keyBy(b.VirtualDJ_Database.Song,(s) => calculateMatchHash(nameForPath(s.$.FilePath),s.$.FileSize));
  out.VirtualDJ_Database.Song = _.map(out.VirtualDJ_Database.Song,(s) => {
    return mergeSongData(s,bByHash[calculateMatchHash(nameForPath(s.$.FilePath),s.$.FileSize)]);
  });
  const songsToAdd = _.difference(Object.keys(aByHash),Object.keys(bByHash));
  for (const key of songsToAdd) {
    out.VirtualDJ_Database.Song.push(byByHash[key]);
  }
  return out;
}

function updateDatabasePaths(db,localFiles) {
  const filesByHash = _.keyBy(localFiles,"hash");
  for (const song of db.VirtualDJ_Database.Song) {
    const hash = calculateMatchHash(nameForPath(song.$.FilePath),song.$.FileSize);
    if (filesByHash[hash]) song.$.FilePath = filesByHash[hash].path;
  }
}

async function main2() {
  const localRoot = process.argv[2];
  const importDatabasePath = process.argv[3];

  const localDatabasePath = findVdjDatabase(localRoot);
  const localDatabase = await loadDatabase(localDatabasePath);

  const importDatabase = await loadDatabase(importDatabasePath);
  const localSongs = await walkFilesystemForSongs(localRoot);

  const newDatabase = mergeDatabases(localDatabase,importDatabase);
  updateDatabasePaths(newDatabase,localSongs);

  saveDatabase(localDatabasePath,newDatabase);
}

function main3() {
}

main3();
