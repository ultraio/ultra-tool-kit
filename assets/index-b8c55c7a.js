import{d as $,j as z,r as a,k as I,a as x,o as i,b as w,h as e,F as C,f as v,w as y,v as k,l as g,m as R,t as j,n as E,L as q,i as V,E as O}from"./index-19647715.js";import{P as W}from"./papaparse.min-3b5bd56c.js";const Y=e("div",{class:"text-3xl font-bold"},"Airdrop (Mass Uniq Mint)",-1),H=e("br",null,null,-1),G={class:"grid gap-4 grid-cols-1"},J={key:0},K=e("span",null,"You are not currently logged in, please log in to view this page.",-1),Q=[K],X=e("div",{class:"grid gap-4 grid-cols-1 text-md p-2 border rounded-md px-4 bg-neutral-700 border-neutral-600"},[e("div",{class:"grid gap-px grid-rows-1"},[e("span",{class:"[font-family:'Inter-Regular',Helvetica] text-[#f9d198]"},[e("b",null,"Input Format"),e("br"),e("br"),e("p",null," Your CSV file must be formatted like below, make sure you have the first row with the header. Duplicate receiver accounts / factories are allowed. ")])]),e("div",{class:"grid gap-px grid-rows-1"},[e("pre",null,[g(""),e("b",null,"account,factory_id"),g(`
ab1bc2cd3de4,123
ab1bc2cd3de4,234
bb1cc2dd3ee4,420
`)])])],-1),Z={class:"grid gap-4 grid-cols-1 text-md p-2 border rounded-md px-5 border-neutral-700"},ee=e("div",{class:"grid gap-px grid-rows-1"},null,-1),te={class:"grid grid-rows-1 gap-4"},ae={class:"grid grid-cols-2 gap-4"},oe={class:"flex flex-row h-12 gap-4"},le={class:"flex flex-row h-12 gap-4"},se={class:"flex flex-row h-12 gap-4"},re={class:"grid grid-cols-3 gap-4 py-4"},ne=e("span",null,null,-1),de=$({__name:"index",props:{state:{},metadata:{}},emits:["transact"],setup(N,{emit:S}){z();const m=N,T=S,l=a(),r=a(),f=a(""),u=a(""),_=a(!1),d=a(!1),c=a([]),n=a([]),p=a(""),b=a();function M(){p.value="",b.value=void 0}const F=()=>{u.value="",_.value=!1,d.value=!1,c.value=[],n.value=[],M()},A=o=>{F(),u.value=o.target.files[0],u.value&&(d.value=!0,_.value=!1,B())},B=async()=>{W.parse(u.value,{header:!0,skipEmptyLines:!0,complete:function(o){o.errors&&(b.value="parse",p.value=o.errors.slice(0,100).map(t=>`${t.message} at row ${t.row}`).join("<br>")),c.value=o.data,D(),_.value=!0,d.value=!1}})},D=()=>{n.value=c.value.map(o=>({contract:"eosio.nft.ft",action:"issue",authorization:[{actor:l.value,permission:r.value}],data:{issue:{to:o.account,token_configs:[{token_factory_id:o.factory_id,amount:1,custom_data:""}],memo:f.value,authorizer:l.value}}}))},L=()=>m.state.accountName?((!l.value||l.value.length===0)&&(O.includes(m.state.accountName)?(l.value="ultra.mrktng",r.value="team"):(l.value=m.state.accountName,r.value="active")),!0):!1;return I(async()=>{}),(o,t)=>{const h=x("LabelWithTooltip"),U=x("Button"),P=x("ErrorModal");return i(),w(C,null,[Y,H,e("div",G,[L()?(i(),w(C,{key:1},[X,e("div",Z,[ee,e("div",te,[e("div",ae,[v(h,{label:"Authorizer"}),e("div",oe,[y(e("input",{class:"flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4","onUpdate:modelValue":t[0]||(t[0]=s=>l.value=s),placeholder:"name"},null,512),[[k,l.value]])]),v(h,{label:"Permission"}),e("div",le,[y(e("input",{class:"flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4","onUpdate:modelValue":t[1]||(t[1]=s=>r.value=s),placeholder:"name"},null,512),[[k,r.value]])]),v(h,{label:"Memo"}),e("div",se,[y(e("input",{class:"flex-grow rounded bg-neutral-950 text-neutral-200 pl-4 border border-neutral-700 focus:outline-none pr-4","onUpdate:modelValue":t[2]||(t[2]=s=>f.value=s),placeholder:"string"},null,512),[[k,f.value]])]),g(" Select CSV File "),e("input",{type:"file",onChange:t[3]||(t[3]=s=>A(s)),accept:".csv",capture:""},null,32)]),e("div",re,[ne,v(U,{disabled:n.value.length==0,onOnClick:t[4]||(t[4]=s=>T("transact",n.value))},{default:R(()=>[g(j(n.value.length?`Mint ${c.value.length} Uniqs`:"Mint"),1)]),_:1},8,["disabled"])])])]),d.value?(i(),E(q,{key:0})):V("",!0)],64)):(i(),w("div",J,Q))]),p.value?(i(),E(P,{key:0,title:b.value=="parse"?"CSV Parsing Error":"Transaction Error",errorMessage:`${p.value}`,onClose:M},null,8,["title","errorMessage"])):V("",!0)],64)}}});export{de as default};
