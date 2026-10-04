'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const script=path.resolve(__dirname,'../deploy/staging/viewer-provider-egress-guard.sh');
const bash=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'/bin/sh';
function shellPath(value){return process.platform==='win32'?value.replace(/\\/g,'/').replace(/^([A-Za-z]):/,(_,drive)=>`/${drive.toLowerCase()}`):value;}
function fixture(t,running){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-egress-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const stub=`#!/bin/sh
name=\${0##*/}
printf '%s %s\\n' "$name" "$*" >> "$GUARD_TEST_LOG"
case "$name" in
 docker)
  case "$*" in
   'ps '*) printf '%s' "$GUARD_TEST_RUNNING";;
   *Subnet*) printf '172.23.0.0/16';;
   *Gateway*) printf '172.23.0.1';;
   *EnableIPv6*) printf 'false';;
   *Id*) printf 'bb6e8d4ba0c4ffffffff';;
  esac;;
 sysctl) case "$*" in *net.ipv4.ip_forward*) printf '1';; *) printf '0';; esac;;
 iptables|ip6tables) case " $* " in *' -C '*) exit 1;; esac;;
esac
`;
 for(const name of ['docker','iptables','ip6tables','sysctl','ip'])fs.writeFileSync(path.join(root,name),stub,{mode:0o755});
 const log=path.join(root,'calls.log');
 const result=spawnSync(bash,['-c','PATH="$GUARD_TEST_BIN:$PATH"; export PATH; exec sh "$GUARD_TEST_SCRIPT" apply'],{encoding:'utf8',env:{...process.env,GUARD_TEST_BIN:shellPath(root),GUARD_TEST_LOG:shellPath(log),GUARD_TEST_SCRIPT:shellPath(script),GUARD_TEST_RUNNING:running}});
 return{result,calls:fs.existsSync(log)?fs.readFileSync(log,'utf8'):''};
}
test('egress guard refuses policy rebuild while supervised containers are running',t=>{
 const{result,calls}=fixture(t,'viewer-staging-viewer-api-1');assert.notEqual(result.status,0);assert.match(result.stderr,/stop the supervised Viewer staging stack/);assert.doesNotMatch(calls,/^iptables /m);
});
test('stopped-stack policy scopes cluster flows and IPv6 guards without flushing unrelated chains',t=>{
 const{result,calls}=fixture(t,'');assert.equal(result.status,0,result.stderr);assert.match(calls,/-s 172\.23\.0\.3 -d 192\.168\.50\.89 -p tcp --dport 4000/);assert.match(calls,/-s 172\.23\.0\.4 -d 192\.168\.50\.89 -p tcp --dport 4000/);assert.match(calls,/-s 172\.23\.0\.2 -d 172\.23\.0\.3 -p tcp --dport 8088/);assert.match(calls,/-A LTDS_VW_STG_IN -s 172\.23\.0\.3 -j REJECT/);assert.match(calls,/ip6tables .* -A LTDS_VW_STG_V6 -i br-bb6e8d4ba0c4 -j DROP/);assert.doesNotMatch(calls,/-F (?:DOCKER-USER|INPUT|FORWARD)(?:\s|$)/);assert.doesNotMatch(calls,/-D (?:INPUT|FORWARD) -[io] /);
 assert.match(calls,/-A LTDS_VW_STG_IN -s 172\.23\.0\.2 -m conntrack --ctstate NEW,INVALID,UNTRACKED -j REJECT/);
});
