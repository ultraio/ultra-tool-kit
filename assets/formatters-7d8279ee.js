function u(r,l){if(r==null&&l==null)return"Tradable Forever";if(r==null&&l==="1970-01-01T00:00:00.000Z")return"Non-tradable";if(r==null&&l)return`Tradeable until ${l}`;if(r&&l==null)return`Tradeable from ${r}`;if(r&&l)return`Tradeable from ${r} to ${l}`}function f(r,l){if(r==null&&l==null)return"Transferable Forever";if(r==null&&l==="1970-01-01T00:00:00.000Z")return"Non-transferable";if(r==null&&l)return`Transferable until ${l}`;if(r&&l==null)return`Transferable from ${r}`;if(r&&l)return`Transferable from ${r} to ${l}`}function n(r){return r||"null"}export{u as a,f as b,n as f};
