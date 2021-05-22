const fs = require("fs");
const xml2js = require("xml2js");
const _ = require("lodash");
const path = require("path");
const os = require("os");
const child_process = require('child_process');
const util = require("util");
const isWin = process.platform === "win32";

const firstFrom = (a) => a ? a[0] : null;
const songsMatch = (a,b) => a.$.FileSize === b.$.FileSize && path.basename(a.$.FilePath) === path.basename(b.$.FilePath);
const calculateMatchHash = (name,size) => `${size}_${name}`;
const isWindowsPath = (p) => p.indexOf("\\") !== -1;
const parsePath = (p) => isWindowsPath(p) ? path.win32.parse(p) : path.posix.parse(p);
const nameForPath = (p) => parsePath(p).base;
const exec = async (cmd) => util.promisify(child_process.exec)(cmd);
const execDir = async (dir,cmd) => util.promisify(child_process.exec)(cmd,{cwd:dir});

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

function mergeSongData(from_vdj,from_json) {
  if (!from_vdj) return from_json;
  if (!from_json) return from_vdj;
  const res = _.merge(from_vdj,from_json);
  res.$ = _.merge(from_vdj.$,from_json.$);
  res.Tags = [_.merge(firstFrom(from_vdj.Tags),firstFrom(from_json.Tags))];
  res.Infos = [_.merge(firstFrom(from_vdj.Infos),firstFrom(from_json.Infos))];
  res.Scan = [_.merge(firstFrom(from_vdj.Scan),firstFrom(from_json.Scan))];
  res.Poi = [...from_vdj.Poi || [],...from_json.Poi ||[]];
  res.Poi = _.uniqBy(res.Poi,(p) => p.$.Name || p.$.Pos);

  const cues = new Set();
  for (p of res.Poi) {
    if (cues.has(p.$.Num)) delete p.$.Num;
    if (p.$.Num) cues.add(p.$.Num);
  }
  return res;
}

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
  const importRepositoryPath = process.argv[3];

  await execDir(importRepositoryPath,"git pull origin master");

  const importDatabasePath = path.join(importRepositoryPath,"database.xml");

  const localDatabasePath = findVdjDatabase(localRoot);
  const localDatabase = await loadDatabase(localDatabasePath);

  const importDatabase = await loadDatabase(importDatabasePath);
  const localSongs = await walkFilesystemForSongs(localRoot);

  const newDatabase = mergeDatabases(localDatabase,importDatabase);

  //Update the repository version
  console.log("Updating repository database.xml...");
  saveDatabase(importDatabasePath,newDatabase);
  await execDir(importRepositoryPath,"git add database.xml");
  const changes = await execDir(importRepositoryPath,`git status --porcelain`);
  if (changes.length > 0) {
    await execDir(importRepositoryPath,`git commit -m 'Updated database.xml from ${os.hostname()}'`);
    await execDir(importRepositoryPath,`git push origin master`);
  } else {
    console.log("No changes made.");
  }

  //Update the local database
  console.log("Updating local database.xml...");
  updateDatabasePaths(newDatabase,localSongs);
  saveDatabase(localDatabasePath,newDatabase);
}

main2();
