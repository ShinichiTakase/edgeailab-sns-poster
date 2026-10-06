const crypto=require("crypto");
const fs=require("fs");
const path=require("path");
const {openDatabase}=require("../db/connection");
const {migrate}=require("../db/migrationRunner");
const {loadExport}=require("./inspectExport");
const {createShadowImporter}=require("./shadowImporter");
const {verifyShadow}=require("./verifyShadow");

function loadOrCreateKey(filename){
  if(fs.existsSync(filename))return Buffer.from(fs.readFileSync(filename,"utf8").trim(),"base64");
  const key=crypto.randomBytes(32);fs.writeFileSync(filename,key.toString("base64"),{mode:0o600,flag:"wx"});return key;
}
function arg(name){const i=process.argv.indexOf(name);if(i<0||!process.argv[i+1])throw new Error(`${name} is required`);return process.argv[i+1];}
function main(){
  const exportDirectory=arg("--export");const databasePath=arg("--database");const keyPath=arg("--key-file");
  if(databasePath==="/app/data/sns-poster.sqlite3")throw new Error("production database path is forbidden for shadow migration");
  const key=loadOrCreateKey(keyPath);const keyring={currentVersion:1,keys:new Map([[1,key]])};
  const bundle=loadExport(exportDirectory);const db=openDatabase(databasePath);
  try{migrate(db);const importer=createShadowImporter(db,{keyring});const first=importer.importBundle(bundle);const second=importer.importBundle(bundle);
    const verification=verifyShadow(db,bundle);const report={firstImportRerun:first.rerun,secondImportRerun:second.rerun,
      quality:first.quality,verification};const reportPath=path.join(path.dirname(databasePath),"phase2-report.json");
    fs.writeFileSync(reportPath,`${JSON.stringify(report,null,2)}\n`,{mode:0o600});
    console.log(JSON.stringify({firstImportRerun:first.rerun,secondImportRerun:second.rerun,quality:first.quality,
      allChecksPass:verification.allChecksPass,tableCounts:verification.tableCounts,quarantine:verification.quarantine,
      integrityCheck:verification.integrityCheck,foreignKeyErrors:verification.foreignKeyErrors}));
  }finally{db.close();}
}
if(require.main===module){try{main();}catch(error){console.error(error.message);process.exitCode=1;}}
