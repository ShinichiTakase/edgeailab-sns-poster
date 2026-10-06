const { openDatabase }=require("./connection");const { onlineBackup }=require("./backup");
const [source,destination]=process.argv.slice(2);if(!source||!destination)throw new Error("usage: node src/db/backupCli.js SOURCE_DB DESTINATION_DB");
const db=openDatabase(source);onlineBackup(db,destination).then(m=>{db.close();console.log(JSON.stringify({ok:true,bytes:m.bytes,sha256:m.sha256}));},e=>{db.close();throw e;});
