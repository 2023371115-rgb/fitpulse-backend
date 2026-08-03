require('dotenv').config();
const { init } = require('./db');

(async ()=>{
  try{
    await init();
    console.log('Migration applied successfully');
    process.exit(0);
  }catch(err){
    console.error('Migration failed', err);
    process.exit(1);
  }
})();
