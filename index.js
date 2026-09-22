const { app, initDb, closeDb } = require('./app');
 
//const PORT = process.env.PORT || 3000;

initDb().then(() => { // 6. 修正了 .then() => 的语法错误
  app.listen(PORT, () => {
    // 7. 修正了单引号为反引号 (`)，这样 ${PORT} 才能生效
    console.log(`🚀 Your server is running at: http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error("❌ Database initialization failed:", err);
});