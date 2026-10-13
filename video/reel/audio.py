import numpy as np, wave
SR=48000; D=60.0; N=int(SR*D)
L=np.zeros(N); R=np.zeros(N)
rs=np.random.default_rng(7)
def add(sig,t,pan=0.0,g=1.0):
    i=int(t*SR); n=min(len(sig),N-i)
    if n<=0: return
    L[i:i+n]+=sig[:n]*g*(1-max(pan,0)); R[i:i+n]+=sig[:n]*g*(1+min(pan,0))
def env(n,a,d):
    e=np.ones(n); ai=int(a*SR); e[:ai]=np.linspace(0,1,ai) if ai else 1
    return e*np.exp(-np.arange(n)/SR/d)
def kick(g=1):
    n=int(.45*SR); t=np.arange(n)/SR; f=45+110*np.exp(-t*28)
    return np.sin(2*np.pi*np.cumsum(f)/SR)*np.exp(-t*7)*g
def hat(d=.04):
    n=int(.08*SR); x=rs.standard_normal(n); x=np.diff(x,prepend=0); return x*np.exp(-np.arange(n)/SR/d)*.18
def noise_sweep(dur,up=True):
    n=int(dur*SR); x=rs.standard_normal(n); t=np.arange(n)/n
    # crude one-pole lowpass with moving cutoff
    a=(t if up else 1-t)**2*.9+.02; y=np.zeros(n); s=0
    for i in range(n): s+=a[i]*(x[i]-s); y[i]=s
    return y*(t if up else (1-t))**1.5*.5
def boom(g=1):
    n=int(2.2*SR); t=np.arange(n)/SR; f=38+60*np.exp(-t*6)
    s=np.sin(2*np.pi*np.cumsum(f)/SR)*np.exp(-t*1.6)
    nz=rs.standard_normal(n)*np.exp(-t*9)*.35
    return (s+nz)*g
def tone(f,dur,a=.01,d=1.0,g=.2,shape='sine'):
    n=int(dur*SR); t=np.arange(n)/SR
    w=np.sin(2*np.pi*f*t)+.3*np.sin(2*np.pi*2*f*t)+.12*np.sin(2*np.pi*3*f*t)
    return w*env(n,a,d)*g
def whoosh(dur=.7):
    n=int(dur*SR); x=rs.standard_normal(n); t=np.linspace(0,1,n)
    e=np.sin(np.pi*t)**2; y=np.zeros(n); s=0
    for i in range(n):
        a=.03+.5*e[i]; s+=a*(x[i]-s); y[i]=s
    return y*e*.6
# --- pad drone (whole piece) A minor-ish
t=np.arange(N)/SR
pad=np.zeros(N)
for f,g in [(55,.10),(110,.06),(164.8,.035),(220,.03),(261.6,.02)]:
    pad+=g*np.sin(2*np.pi*f*t+np.sin(t*.3*f/55)*.4)
pad*=np.clip(t/2.5,0,1)*(1-.6*np.clip((t-55.2)/.3,0,1)*(t<55.8))
L+=pad; R+=pad*.98
# --- intro: shimmer arps
for k,(tt,f) in enumerate([(.15,440),(.45,659.3),(.75,880),(1.2,987.8),(1.55,1318.5)]):
    add(tone(f,1.6,d=.6,g=.07),tt,pan=(-.5 if k%2 else .5))
for tt in np.arange(2.0,2.35,.04): add(hat(.012),tt,g=1.5)  # wordmark typing ticks
add(noise_sweep(1.0),2.2,g=.8)
# --- chaos
bpm=128; b=60/bpm
add(boom(.9),2.95)
tt=2.95
while tt<7.4:
    add(kick(.9),tt)
    add(hat(),tt+b/2,pan=.3); add(hat(.02),tt+b/4,pan=-.3,g=.6); add(hat(.02),tt+3*b/4,pan=-.3,g=.6)
    tt+=b
for tt0 in (3.3,4.45,5.6,6.75): add(tone(110,0.5,d=.25,g=.25),tt0)
add(noise_sweep(.6),7.4,g=1.2)
for k in range(10): add(kick(.4),7.45+k*.05)
H=8.03
add(boom(1.0),H)
add(tone(220,3,d=1.5,g=.12),H); add(tone(329.6,3,d=1.5,g=.08),H)
tt=H; n=0
while tt<55.2:
    # breathe: drop the kick for a bar at each section change so holds feel calmer
    quiet=any(abs(tt-c)<1.0 for c in (23.0,29.0,35.0,48.0))
    if not quiet: add(kick(.7),tt)
    add(hat(),tt+b/2,pan=.25,g=.8)
    if n%2==1 and not quiet: add(hat(.07)*1.3,tt,pan=-.2)
    tt+=b; n+=1
for tt0,f in [(9.5,880),(10.6,988),(11.7,1175),(16.9,1318.5),(19.6,1175),(23.7,880),(24.2,1046),(32.6,1318.5)]:
    add(tone(f,.45,d=.14,g=.09),tt0,pan=.2)
add(whoosh(1.3),13.7,g=.9)
for c in (23.0,29.0,35.0,48.0): add(whoosh(.8),c-.4,g=1.1); add(boom(.45),c)
for k in range(10): add(tone(440*2**(k/6),.25,d=.07,g=.07),29.7+k*.25,pan=(k%2-.5))
# handoff idea
add(tone(587.3,.4,d=.15,g=.1),35.5)
add(tone(784,.5,d=.2,g=.1),36.4); add(tone(1174.7,.5,d=.2,g=.06),36.4)
add(whoosh(1.1),37.75,g=.9)
add(tone(880,.9,d=.45,g=.12),38.8); add(tone(1318.5,.9,d=.45,g=.08),38.8)
add(whoosh(.9),39.95,g=.6)
for k,f in enumerate([1046.5,1318.5,1568]): add(tone(f,.5,d=.2,g=.08),40.8+k*.07)
add(boom(.7),41.5)
for tt0,f in [(42.1,784),(42.6,988),(43.8,1046),(43.95,1318.5),(45.0,1175),(45.35,1318.5)]: add(tone(f,.4,d=.12,g=.09),tt0,pan=-.2)
# slack
for k in range(3): add(tone(587.3*(1+k*.25),.3,d=.08,g=.08),48.2+k*.15)
cl=np.zeros(int(.03*SR)); cl[:60]=1; cl=np.diff(cl,prepend=0)*.6
add(cl,51.08); add(tone(1760,.25,d=.06,g=.08),51.08)
add(noise_sweep(.6),54.7,g=1.0)
# end
E=55.5
add(noise_sweep(1.0),E-1.1,g=1.3)
add(boom(1.2),E)
for f,g in [(110,.16),(220,.12),(277.2,.09),(329.6,.09),(440,.07),(554.4,.05)]:
    add(tone(f,4.5,a=.02,d=3.0,g=g),E)
for k,f in enumerate([880,1108.7,1318.5,1760]): add(tone(f,1.6,d=.6,g=.05),E+.35+k*.12,pan=(.4 if k%2 else -.4))
# master: soft clip + fade
mix=np.stack([L,R],1)*0.55
fade=np.clip((D-t)/0.6,0,1); mix*=fade[:,None]
mix=np.tanh(mix*1.3)/np.tanh(1.3)
pcm=(mix/np.max(np.abs(mix))*0.92*32767).astype(np.int16)
w=wave.open('sound.wav','wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes()); w.close()
print('ok')
