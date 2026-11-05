# Mede quanto cada ponte aguenta: manda texto de N mil caracteres com 3 códigos (início, meio, fim) e confere se o modelo os leu.
# Uso: python3 gateway/medir-limite.py <provedor do opencode.jsonc> <tamanhos em mil chars...>   ex.: deepseek 100 300 500
import re,json,os,time,random,urllib.request,sys
t=re.sub(r'^\s*//.*$','',open(os.path.expanduser('~/.config/opencode/opencode.jsonc')).read(),flags=re.M)
prov=sys.argv[1]
cfg=json.loads(t)['provider'][prov]
key=cfg['options']['apiKey'];base=cfg['options']['baseURL'];model=list(cfg['models'])[0]
random.seed(7)
words="rio monte vento chave porta livro nuvem ponte campo pedra sol lua mar fogo terra".split()
def filler(n):
    out=[];size=0
    while size<n:
        line=" ".join(random.choice(words) for _ in range(12))+f" #{random.randint(1000,9999)}.\n"
        out.append(line);size+=len(line)
    return "".join(out)
for kb in [int(x) for x in sys.argv[2:]]:
    a,m,b=[random.randint(100000,999999) for _ in range(3)]
    half=kb*500
    body=f"CODIGO-INICIAL={a}\n"+filler(half)+f"CODIGO-MEIO={m}\n"+filler(half)+f"CODIGO-FINAL={b}\n"
    prompt=body+"\nResponda apenas com os três códigos do texto acima: CODIGO-INICIAL, CODIGO-MEIO e CODIGO-FINAL."
    req=urllib.request.Request(base+"/chat/completions",data=json.dumps({"model":model,"messages":[{"role":"user","content":prompt}]}).encode(),headers={"content-type":"application/json","authorization":"Bearer "+key,"x-opencode-session-id":f"probe-{kb}-{int(time.time())}"})
    t0=time.time()
    try:
        r=json.load(urllib.request.urlopen(req,timeout=500))
        ans=r["choices"][0]["message"]["content"]
        ok=all(str(x) in ans for x in (a,m,b))
        print(f"[{prov}] {len(prompt)//1000}k chars: {'LEU OS TRES' if ok else 'ERROU'} em {time.time()-t0:.0f}s | início={str(a) in ans} meio={str(m) in ans} fim={str(b) in ans} | {ans[:80]!r}",flush=True)
    except urllib.error.HTTPError as e:
        print(f"[{prov}] {len(prompt)//1000}k chars: HTTP {e.code} {e.read()[:150]!r} em {time.time()-t0:.0f}s",flush=True)
    except Exception as e:
        print(f"[{prov}] {len(prompt)//1000}k chars: {type(e).__name__} {e} em {time.time()-t0:.0f}s",flush=True)
