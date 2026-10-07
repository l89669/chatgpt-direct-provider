'use strict';
/** Builds a reproducible VSIX from untransformed CommonJS sources. No npm download,
 * VSCE installation, network access, shell invocation or signing credential. */
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const table=Array.from({length:256},(_,i)=>{let c=i;for(let n=0;n<8;n++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(buf){let c=0xffffffff;for(const b of buf)c=table[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
function zip(entries){const local=[],central=[];let offset=0;
  // Fixed 2026-10-06 00:00:00 ZIP timestamp; inputs determine the resulting bytes.
  const date=((2026-1980)<<9)|(10<<5)|6;
  for(const[name,data]of entries.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0)){
    if(name.startsWith('/')||name.includes('..')||name.includes('\\'))throw new Error('Unsafe ZIP path');
    const n=Buffer.from(name),raw=Buffer.isBuffer(data)?data:Buffer.from(data),compressed=zlib.deflateRawSync(raw,{level:9}),crc=crc32(raw);
    const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt16LE(8,8);h.writeUInt16LE(date,12);h.writeUInt32LE(crc,14);h.writeUInt32LE(compressed.length,18);h.writeUInt32LE(raw.length,22);h.writeUInt16LE(n.length,26);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(0x314,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(8,10);c.writeUInt16LE(date,14);c.writeUInt32LE(crc,16);c.writeUInt32LE(compressed.length,20);c.writeUInt32LE(raw.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE((0o100644*65536)>>>0,38);c.writeUInt32LE(offset,42);
    local.push(h,n,compressed);central.push(c,n);offset+=h.length+n.length+compressed.length;
  }
  const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,cd,end]);
}
function xml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'})[c]);}
function filesUnder(relative){const base=path.join(root,relative);return fs.readdirSync(base,{withFileTypes:true}).flatMap(e=>{const r=relative?`${relative}/${e.name}`:e.name;if(e.isSymbolicLink())throw new Error('Symlinks are not packaged');return e.isDirectory()?filesUnder(r):[r];});}
const contentTypes=`<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="txt" ContentType="text/plain"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>`;
const manifest=`<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata><Identity Language="en-US" Id="${xml(pkg.name)}" Version="${xml(pkg.version)}" Publisher="${xml(pkg.publisher)}"/><DisplayName>${xml(pkg.displayName)}</DisplayName><Description xml:space="preserve">${xml(pkg.description)}</Description><Tags>${xml(pkg.keywords.join(','))}</Tags><Categories>${xml(pkg.categories.join(','))}</Categories><GalleryFlags>Preview</GalleryFlags>
  <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(pkg.engines.vscode)}"/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui"/><Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value=""/><Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true"/><Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true"/><Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true"/></Properties></Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true"/></Assets>
</PackageManifest>`;
function write(file,entries){const bytes=zip(entries);fs.writeFileSync(file,bytes);console.log(`${file}\n  ${bytes.length} bytes; SHA256 ${crypto.createHash('sha256').update(bytes).digest('hex')}`);}
const output=path.join(root,'dist');fs.mkdirSync(output,{recursive:true});
const runtime=['package.json','README.md','PRIVACY.md','SECURITY.md','CHANGELOG.md',...filesUnder('src'),...filesUnder('docs')];
write(path.join(output,`${pkg.name}-${pkg.version}.vsix`),[['[Content_Types].xml',contentTypes],['extension.vsixmanifest',manifest],...runtime.map(f=>[`extension/${f}`,fs.readFileSync(path.join(root,f))])]);
const excluded=new Set(['dist','node_modules','.git','.test-host']);
function sourceFiles(relative=''){return fs.readdirSync(path.join(root,relative),{withFileTypes:true}).flatMap(e=>{if(excluded.has(e.name))return[];if(e.isSymbolicLink())throw new Error('Symlinks are not packaged');const r=relative?`${relative}/${e.name}`:e.name;return e.isDirectory()?sourceFiles(r):[r];});}
write(path.join(output,`${pkg.name}-${pkg.version}-source.zip`),sourceFiles().map(f=>[`${pkg.name}/${f}`,fs.readFileSync(path.join(root,f))]));
