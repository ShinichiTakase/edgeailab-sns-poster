const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { openDatabase } = require("./connection");
function sha256(file){const h=crypto.createHash("sha256");h.update(fs.readFileSync(file));return h.digest("hex");}
async function onlineBackup(sourceDb,destination,{label="sns-poster"}={}){fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});await sourceDb.backup(destination);const check=new Database(destination,{readonly:true});const integrity=check.pragma("integrity_check",{simple:true});check.close();if(integrity!=="ok")throw new Error(`backup integrity check failed: ${integrity}`);const manifest={label,createdAt:new Date().toISOString(),filename:path.basename(destination),sha256:sha256(destination),bytes:fs.statSync(destination).size};fs.writeFileSync(`${destination}.manifest.json`,JSON.stringify(manifest,null,2)+"\n",{mode:0o600});return manifest;}
function restoreBackup(backup,destination){const manifest=JSON.parse(fs.readFileSync(`${backup}.manifest.json`,"utf8"));if(sha256(backup)!==manifest.sha256)throw new Error("backup checksum mismatch");if(fs.existsSync(destination))throw new Error("restore destination already exists");fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});fs.copyFileSync(backup,destination,fs.constants.COPYFILE_EXCL);fs.chmodSync(destination,0o600);const db=openDatabase(destination);const integrity=db.pragma("integrity_check",{simple:true});if(integrity!=="ok"){db.close();throw new Error(`restored database integrity check failed: ${integrity}`);}return db;}
module.exports={sha256,onlineBackup,restoreBackup};
