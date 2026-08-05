#!/usr/bin/env tsx

import { execSync } from 'child_process';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331'; // Use 127.0.0.1 instead of localhost
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

async function checkPortAvailability(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = new net.Socket();
    
    socket.setTimeout(2000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    
    socket.on('error', () => {
      resolve(false);
    });
    
    socket.connect(port, host);
  });
}

async function waitForServices(url: string, anonKey: string, serviceKey: string): Promise<boolean> {
  console.log('⏳ Waiting for Supabase services to be ready...');
  
  // Extract host and port from URL
  const urlObj = new URL(url);
  const host = urlObj.hostname;
  const port = parseInt(urlObj.port);
  
  console.log(`🌐 Target: ${host}:${port}`);
  
  let retries = 0;
  const maxRetries = 20; // Increased retries
  const retryInterval = 5000; // Increased interval for CI
  
  // First, wait for the port to be available
  console.log('🔌 Checking if Supabase API port is available...');
  while (retries < maxRetries) {
    const portOpen = await checkPortAvailability(host, port);
    if (portOpen) {
      console.log(`✅ Port ${port} is available on ${host}`);
      break;
    } else {
      retries++;
      if (retries < maxRetries) {
        console.log(`⏳ Port not ready, retrying in ${retryInterval/1000}s... (${retries}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, retryInterval));
      }
    }
  }
  
  if (retries >= maxRetries) {
    console.error(`❌ Port ${port} never became available on ${host}`);
    
    // Debug: Show what's actually running
    try {
      console.log('🔍 Debug: Checking running containers...');
      const containers = execSync('docker ps --format "table {{.Names}}\\t{{.Ports}}"', { encoding: 'utf-8' });
      console.log(containers);
    } catch {
      console.log('Could not list containers');
    }
    
    return false;
  }
  
  // Reset retry counter for API tests
  retries = 0;
  
  // Now test the actual API endpoints
  while (retries < maxRetries) {
    try {
      console.log(`🔍 Testing Supabase API... (attempt ${retries + 1}/${maxRetries})`);
      
      // Test basic database connection with Supabase client directly
      console.log('🗃️ Testing database connection...');
      const client = createClient(url, anonKey);
      
      const { data: _basicTest, error: basicError } = await client
        .from('tenant')
        .select('count', { count: 'exact', head: true });
      
      if (basicError) {
        console.log(`❌ Database connection failed: ${basicError.message}`);
        throw new Error(`Database connection failed: ${basicError.message}`);
      }
      
      console.log('✅ Database connection successful');
      
      // Test admin connection
      console.log('🔐 Testing admin connection...');
      const adminClient = createClient(url, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false }
      });
      
      const { data: _adminTest, error: adminError } = await adminClient
        .from('tenant')
        .select('tenant_id')
        .limit(1);
      
      if (adminError) {
        console.log(`❌ Admin connection failed: ${adminError.message}`);
        throw new Error(`Admin connection failed: ${adminError.message}`);
      }
      
      console.log('✅ Admin connection successful');
      console.log('✅ All services are ready!');
      return true;
      
    } catch (error) {
      retries++;
      console.log(`❌ Connection test failed:`, error);
      
      if (retries < maxRetries) {
        console.log(`⏳ Services not ready yet, retrying in ${retryInterval/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, retryInterval));
      } else {
        console.error(`❌ Services failed to start after ${maxRetries} attempts:`, {
          message: error instanceof Error ? error.message : String(error),
          details: error instanceof Error ? error.stack : String(error),
          hint: 'Check if Supabase containers are running and ports are accessible',
          code: ''
        });
        return false;
      }
    }
  }
  
  return false;
}

async function setupDatabase() {
  console.log('🚀 Setting up integration test database...');
  console.log(`📊 Supabase URL: ${SUPABASE_URL}`);
  console.log(`🔑 Service Role Key: ${SUPABASE_SERVICE_ROLE_KEY.substring(0, 20)}...`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🏗️  CI Environment: ${process.env.CI ? 'true' : 'false'}`);

  // Set environment variables for the integration tests
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;
  
  // Set OAuth provider environment variables for integration tests
  process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
  process.env.GITHUB_CLIENT_ID = 'test-github-client-id';
  process.env.GITHUB_CLIENT_SECRET = 'test-github-client-secret';
  process.env.SUPABASE_AUTH_REDIRECT_URI = 'http://localhost:3002/auth/callback';

  try {
    const intTestDir = join(__dirname, '..');
    console.log(`📂 Working directory: ${intTestDir}`);

    // Check if migrations directory exists and is accessible
    console.log('🔍 Checking migrations directory...');
    try {
      const { readdirSync, statSync } = require('fs');
      const migrationsPath = join(intTestDir, 'supabase', 'migrations');
      console.log(`📁 Migrations path: ${migrationsPath}`);
      
      const stat = statSync(migrationsPath);
      if (stat.isSymbolicLink()) {
        console.log('🔗 Migrations directory is a symbolic link');
        const { readlinkSync } = require('fs');
        const target = readlinkSync(migrationsPath);
        console.log(`🎯 Symlink target: ${target}`);
        
        // Verify target exists
        const { existsSync } = require('fs');
        const fullTarget = target.startsWith('/') ? target : join(migrationsPath, '..', target);
        if (existsSync(fullTarget)) {
          console.log('✅ Symlink target exists');
        } else {
          console.error('❌ Symlink target does not exist');
          
          // If we're in CI and symlink is broken, try to copy migrations from tenant-dashboard
          if (process.env.CI) {
            console.log('🔧 CI environment detected, attempting to copy migrations...');
            const sourcePath = join(intTestDir, '..', 'tenant-dashboard', 'supabase', 'migrations');
            if (existsSync(sourcePath)) {
              const { rmSync, cpSync } = require('fs');
              
              // Remove broken symlink
              rmSync(migrationsPath, { force: true });
              
              // Copy migrations from source
              cpSync(sourcePath, migrationsPath, { recursive: true });
              console.log('✅ Migrations copied successfully');
            } else {
              throw new Error(`Source migrations not found at: ${sourcePath}`);
            }
          } else {
            throw new Error(`Symlink target does not exist: ${fullTarget}`);
          }
        }
      } else {
        console.log('📁 Migrations directory is a regular directory');
      }
      
      const files = readdirSync(migrationsPath);
      console.log(`📋 Found ${files.length} migration files`);
      if (files.length > 0) {
        console.log(`📄 First few migrations: ${files.slice(0, 3).join(', ')}`);
      }
      
      if (files.length === 0) {
        throw new Error('No migration files found - database setup will fail');
      }
    } catch (error) {
      console.error('❌ Failed to check migrations directory:', error);
      throw error;
    }

    // Always start/restart Supabase to ensure clean state
    // Retry logic handles intermittent port conflicts (TCP TIME_WAIT after container stop)
    console.log('🚀 Starting Supabase...');
    const maxStartRetries = 3;
    for (let attempt = 1; attempt <= maxStartRetries; attempt++) {
      try {
        // Stop any lingering containers first to avoid port conflicts
        if (attempt > 1) {
          console.log(`🔄 Retry ${attempt}/${maxStartRetries}: stopping lingering containers...`);
          try {
            execSync('npx supabase stop --no-backup', { cwd: intTestDir, stdio: 'inherit' });
          } catch { /* ignore stop errors */ }
          // Wait for ports to be released by the OS
          const waitSec = attempt * 5;
          console.log(`⏳ Waiting ${waitSec}s for ports to be released...`);
          await new Promise(resolve => setTimeout(resolve, waitSec * 1000));
        }
        execSync('npx supabase start', {
          cwd: intTestDir,
          stdio: 'inherit'
        });
        console.log('✅ Supabase started successfully');
        break;
      } catch (error) {
        console.error(`❌ Supabase start failed (attempt ${attempt}/${maxStartRetries}):`, error);
        if (attempt === maxStartRetries) {
          console.error('❌ All start attempts exhausted');
          process.exit(1);
        }
      }
    }

    // Reset database to ensure clean state
    // In CI, npx supabase start already applies migrations - no seed needed
    // Integration tests create their own test data
    if (process.env.CI) {
      console.log('✅ CI environment: migrations applied by supabase start (no seed required)');
    } else {
      console.log('🌱 Resetting database to ensure clean state...');
      try {
        execSync('npx supabase db reset', {
          cwd: intTestDir,
          stdio: 'inherit'
        });
        console.log('✅ Database reset complete with seed data');
      } catch (error) {
        console.error('❌ Failed to reset database:', error);
        process.exit(1);
      }
    }

    // Poll until migrations are applied and PostgREST is ready
    console.log('⏳ Waiting for migrations to be applied...');
    const migrationStart = Date.now();
    const migrationTimeout = process.env.CI ? 30000 : 15000;
    let migrationsReady = false;
    while (Date.now() - migrationStart < migrationTimeout) {
      try {
        const testClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
          auth: { autoRefreshToken: false, persistSession: false }
        });
        const { error } = await testClient.from('tenant').select('count', { count: 'exact', head: true });
        if (!error) {
          migrationsReady = true;
          console.log('✅ Migrations applied and database ready');
          break;
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!migrationsReady) {
      console.warn('⚠️ Migration readiness check timed out, proceeding anyway...');
    }

    // Trigger PostgREST schema cache reload to ensure it sees all tables
    console.log('🔄 Triggering PostgREST schema cache reload...');
    try {
      execSync(
        'docker exec -i supabase_db_integration-tests psql -U postgres -c "NOTIFY pgrst, \'reload schema\';"',
        { cwd: intTestDir, stdio: 'inherit', shell: '/bin/bash' }
      );
      console.log('✅ PostgREST schema reload triggered');
      // Poll until PostgREST reflects schema changes
      let schemaReady = false;
      const schemaStart = Date.now();
      while (Date.now() - schemaStart < 5000) {
        try {
          const testClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
            auth: { autoRefreshToken: false, persistSession: false }
          });
          const { error } = await testClient.from('tenant').select('count', { count: 'exact', head: true });
          if (!error) { schemaReady = true; break; }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!schemaReady) {
        console.warn('⚠️ PostgREST schema reload may not be complete');
      }
    } catch (error) {
      console.warn('⚠️ Failed to trigger PostgREST reload (may not be required):', error);
    }

    // Verify migrations were applied by checking if core tables exist
    console.log('🔍 Verifying migrations were applied...');
    let verificationSuccess = false;
    let retryCount = 0;
    const maxRetries = 3;
    
    while (!verificationSuccess && retryCount < maxRetries) {
      try {
        const testClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
          auth: { autoRefreshToken: false, persistSession: false }
        });
        
        // Test if key tables exist
        const tables = ['tenant', 'profile', 'membership', 'app', 'api_key'];
        for (const table of tables) {
          try {
            const { error } = await testClient
              .from(table)
              .select('count', { count: 'exact', head: true });
            
            if (error) {
              console.error(`❌ Table ${table} check failed:`, error);
              throw new Error(`Table ${table} does not exist or is not accessible: ${error.message}`);
            } else {
              console.log(`✅ Table ${table} exists and is accessible`);
            }
          } catch (tableError) {
            console.error(`❌ Failed to verify table ${table}:`, tableError);
            throw tableError;
          }
        }
        console.log('✅ All core tables verified successfully');
        verificationSuccess = true;
      } catch (verifyError) {
        retryCount++;
        console.error(`❌ Migration verification failed (attempt ${retryCount}/${maxRetries}):`, verifyError);
        
        if (retryCount < maxRetries) {
          console.log(`⏳ Retrying verification in 5 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        } else {
          // Try to get more info about what's in the database
          try {
            console.log('🔍 Attempting to list existing tables...');
            const debugClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
              auth: { autoRefreshToken: false, persistSession: false }
            });
            
            // Query information schema to see what tables exist
            const { data: tableList, error: listError } = await debugClient
              .from('information_schema.tables')
              .select('table_name')
              .eq('table_schema', 'public');
              
            if (listError) {
              console.log('Could not list tables:', listError);
            } else {
              console.log('📋 Existing tables:', tableList?.map(t => t.table_name) || 'none');
            }
          } catch (debugError) {
            console.log('Could not debug database state:', debugError);
          }
          
          throw verifyError;
        }
      }
    }

    // Wait for services with improved logic
    const servicesReady = await waitForServices(SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY);
    
    if (!servicesReady) {
      console.error('❌ Services failed to become ready - tests may fail');
      process.exit(1);
    }

    console.log('✅ Database setup complete!');
    console.log(`📊 Supabase URL: ${SUPABASE_URL}`);
    console.log(`🔑 Anon Key: ${SUPABASE_ANON_KEY}`);

  } catch (error) {
    console.error('❌ Failed to setup database:', error);
    process.exit(1);
  }
}

async function teardownDatabase() {
  console.log('🧹 Tearing down integration test database...');

  try {
    // Check if Supabase is running before trying to stop it
    try {
      execSync('npx supabase status', { 
        cwd: join(__dirname, '..'),
        stdio: 'pipe'
      });
      // If we get here, Supabase is running, so stop it
      execSync('npx supabase stop', { 
        cwd: join(__dirname, '..'),
        stdio: 'inherit'
      });
      console.log('✅ Database teardown complete!');
    } catch {
      // Supabase is not running, which is fine
      console.log('ℹ️  Supabase is not running, nothing to stop');
    }
  } catch (error) {
    console.error('❌ Failed to teardown database:', error);
    // Don't exit with error code for teardown failures
  }
}

// Handle command line arguments
const command = process.argv[2];

if (command === 'setup') {
  setupDatabase();
} else if (command === 'teardown') {
  teardownDatabase();
} else {
  console.log('Usage: tsx scripts/setup-db.ts [setup|teardown]');
  process.exit(1);
}