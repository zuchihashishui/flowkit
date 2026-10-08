const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('Electron allows prompt settings before Start selected rows and rejects unknown routes',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8');
 const declaration=source.match(/^const storyboardAllowed = (.+);$/m);
 assert.ok(declaration);
 const allowed=vm.runInNewContext(declaration[1]);
 for(const suffix of ['prompt-options','restart-text','generate-concepts','retry-failed'])assert.ok(allowed.test('/api/storyboard/videos/abc-123/'+suffix));
 for(const route of ['/api/storyboard/videos/abc-123/unknown','/api/storyboard/videos/../prompt-options','/api/storyboard/videos/abc-123/prompt-options/extra'])assert.equal(allowed.test(route),false);
});
