// Fixture transport for target_checkout.mjs --signed-in-profile. Both Chrome
// processes are offline. Only this disposable profile ever receives the test cookie.
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export async function openSignedInFixture(chromium, origin) {
  const directory=await mkdtemp(join(tmpdir(),'ps5-auth-fixture-'));
  const cookie='ps5_fixture='+randomUUID();
  const options={channel:'chrome',chromiumSandbox:true,offline:true,serviceWorkers:'block'};
  let context;
  async function close() {
    try {await context?.close();}
    finally {await rm(directory,{recursive:true,force:true});}
  }
  try {
    context=await chromium.launchPersistentContext(directory,{...options,headless:false});
    await context.route('**/*',route=>{
      const request=route.request();
      if(request.url()!==origin+'/fixture-login') return route.abort();
      if(request.method()==='GET') return route.fulfill({contentType:'text/html',body:
        '<form method="post"><button>Sign in to fixture</button></form>'});
      if(request.method()==='POST') return route.fulfill({headers:{
        'Content-Type':'text/html','Set-Cookie':cookie+'; Max-Age=600; Secure; HttpOnly; SameSite=Strict; Path=/'
      },body:'<h1>Signed in to fixture</h1>'});
      return route.abort();
    });
    const page=await context.newPage();
    await page.goto(origin+'/fixture-login');
    await page.getByRole('button',{name:'Sign in to fixture'}).click();
    await page.getByRole('heading',{name:'Signed in to fixture'}).waitFor();
    await context.close();
    context=await chromium.launchPersistentContext(directory,{...options,headless:true});
    return {context,close,isSignedIn:async request=>{
      const headers=await request.allHeaders();
      return (headers.cookie||'').split(/;\s*/).includes(cookie);
    }};
  } catch(error) {await close();throw error;}
}
