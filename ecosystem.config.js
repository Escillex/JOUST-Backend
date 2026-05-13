module.exports = {
  apps: [
    {
      name: 'backend',
      script: 'dist/src/main.js',
      cwd: '/home/Escillex/Server/Backend',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
      },
      max_memory_restart: '1G',
      error_file: '/home/Escillex/Server/Backend/logs/error.log',
      out_file: '/home/Escillex/Server/Backend/logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      kill_timeout: 5000,
    },
  ],
}
