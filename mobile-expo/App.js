import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Image, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, StatusBar, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: true }) });

// Standalone installs use the hosted API by default; a local .env can override it for development.
const API = (process.env.EXPO_PUBLIC_API_URL || 'https://keepfresh-njtq.onrender.com').replace(/\/$/, '');
const C = { green: '#33451d', green2: '#506b2e', lime: '#dce8a9', cream: '#f8f7ef', white: '#fff', ink: '#25301e', muted: '#78806e', line: '#e5e7da', red: '#b94235', orange: '#bb7621', yellow: '#a08023', soft: '#eff2e4' };
const TABS = [['Home','⌂'],['Fridge','▣'],['Recipes','♨'],['Groceries','☷'],['Profile','●']];
const today = () => new Date().toISOString().slice(0,10);

export default function App() { return <SafeAreaProvider><AppContent /></SafeAreaProvider>; }

function AppContent() {
  const insets = useSafeAreaInsets();
  const [token, setToken] = useState(null), [boot, setBoot] = useState(true);
  const [tab, setTab] = useState('Home'), [data, setData] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [authMode, setAuthMode] = useState('login'), [auth, setAuth] = useState({ firstName:'', middleName:'', lastName:'', email:'', password:'', householdName:'', inviteCode:'', code:'' });
  const [itemOpen, setItemOpen] = useState(false), [recipe, setRecipe] = useState(null), [alertsOpen, setAlertsOpen] = useState(false);
  const [item, setItem] = useState({ name:'', category:'Other', qty:'1', bought:today(), expires:'' }), [groceryName, setGroceryName] = useState('');
  const [search, setSearch] = useState('');
  const [pushRegistered, setPushRegistered] = useState(false);


  useEffect(() => { SecureStore.getItemAsync('kf-token').then(setToken).finally(() => setBoot(false)); }, []);
  const request = useCallback(async (path, method='GET', body) => {
    if (!API) throw new Error('Set EXPO_PUBLIC_API_URL in mobile-expo/.env to your KeepFresh server address, then restart Expo.');
    const response = await fetch(`${API}/api${path}`, { method, headers: { 'Content-Type':'application/json', ...(token ? { Authorization:`Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && token) { await SecureStore.deleteItemAsync('kf-token'); setToken(null); }
      const e = new Error(payload.error || `Request failed (${response.status})`); e.status = response.status; e.data = payload; throw e;
    }
    return payload;
  }, [token]);
  const refresh = useCallback(async () => {
    if (!token) return;
    setError('');
    try {
      const [me, items, al, catalog, recipes, grocery] = await Promise.all([request('/me'), request('/items'), request('/alerts'), request('/catalog'), request('/recipes'), request('/grocery')]);
      setData({ me, items, alerts:al.alerts || [], unread:al.unread || 0, catalog, recipes, grocery });
    } catch (e) { setError(e.message); }
  }, [token, request]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronize API data with the authenticated session.
  useEffect(() => { if (token) refresh(); else setData(null); }, [token, refresh]);
  const registerPush = useCallback(async () => {
    if (Platform.OS === 'web' || !token || !data?.me?.settings?.push_on || pushRegistered) return;
    try {
      if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('freshness-alerts', { name:'Freshness warnings', importance:7, vibrationPattern:[0,250,250,250], lightColor:C.green2 });
      let permission = await Notifications.getPermissionsAsync();
      if (!permission.granted) permission = await Notifications.requestPermissionsAsync();
      if (!permission.granted) { setNotice('Allow KeepFresh notifications in phone settings to receive expiry warnings.'); return; }
      const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
      if (!projectId) { setNotice('Push notifications need the EAS project ID in the app configuration.'); return; }
      const pushToken = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
      await request('/push/subscribe','POST',{ subscription:{ endpoint:pushToken } });
      setPushRegistered(true);
    } catch (e) { console.warn('[push] registration failed',e); }
  }, [token,data?.me?.settings?.push_on,pushRegistered,request]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- perform native permission/token registration when account settings load.
  useEffect(() => { registerPush(); }, [registerPush]);
  useEffect(() => { const sub=Notifications.addNotificationResponseReceivedListener(()=>{setAlertsOpen(true);refresh();});return ()=>sub.remove(); }, [refresh]);
  const run = async (fn, success) => { setBusy(true); setError(''); setNotice(''); try { await fn(); if (success) setNotice(success); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const login = async () => run(async () => {
    if (authMode === 'verify') { const x = await request('/auth/verify','POST',{ email:auth.email, code:auth.code }); await SecureStore.setItemAsync('kf-token',x.token); setToken(x.token); return; }
    if (authMode === 'register') { await request('/auth/register','POST',{ firstName:auth.firstName, middleName:auth.middleName, lastName:auth.lastName, email:auth.email, password:auth.password, householdName:auth.householdName || undefined, inviteCode:auth.inviteCode || undefined }); setAuthMode('verify'); setNotice('Enter the 6-digit verification code sent to your email.'); return; }
    const x = await request('/auth/login','POST',{ email:auth.email,password:auth.password }); await SecureStore.setItemAsync('kf-token',x.token); setToken(x.token);
  });
  const logout = () => Alert.alert('Log out?', 'Your saved fridge data stays in your household.', [{text:'Cancel',style:'cancel'},{text:'Log out',style:'destructive',onPress:async()=>{try{if(pushRegistered&&Platform.OS!=='web'){const projectId=Constants.expoConfig?.extra?.eas?.projectId??Constants.easConfig?.projectId;const devicePushToken=(await Notifications.getExpoPushTokenAsync({projectId})).data;await request('/push/subscribe','DELETE',{endpoint:devicePushToken});}}catch{}await SecureStore.deleteItemAsync('kf-token');setPushRegistered(false);setToken(null);setData(null);setTab('Home');}}]);
  const addItem = async () => run(async () => {
    let prediction;
    if (!item.expires) prediction = await request('/predict','POST',{ name:item.name, category:item.category, bought:item.bought });
    await request('/items','POST',{ ...item, expires:item.expires || undefined, prediction });
    setItemOpen(false); setItem({ name:'',category:'Other',qty:'1',bought:today(),expires:'' }); await refresh(); setNotice('Added to your refrigerator.');
  });
  const suggest = async () => run(async () => { const r=await request('/recipes/suggest','POST',{}); await refresh(); setNotice(r.generated ? `${r.generated} fridge-matched recipe suggestions ready.` : 'No recipe matched your fresh ingredients.'); });
  const filteredItems = useMemo(() => (data?.items || []).filter((i) => i.name.toLowerCase().includes(search.toLowerCase())), [data,search]);

  if (boot) return <Splash label="Opening KeepFresh…" />;
  if (!token) return <AuthScreen mode={authMode} setMode={setAuthMode} fields={auth} setFields={setAuth} submit={login} busy={busy} error={error} notice={notice} />;
  if (!data) return <Splash label={error || 'Loading your refrigerator…'} action={error ? refresh : null} />;

  const fresh = data.items.filter((i) => i.daysLeft >= 0), attention = data.items.filter((i) => i.daysLeft <= 3 && !i.dismissedToday);
  const label = (i) => i.daysLeft < 0 ? 'Expired' : i.daysLeft === 0 ? 'Use today' : `${i.daysLeft} days left`;
  const badgeColor = (i) => i.daysLeft < 0 ? C.red : i.daysLeft <= 1 ? C.orange : i.daysLeft <= 3 ? C.yellow : C.green2;
  const renderHome = () => <>
    <View style={s.hero}><Text style={s.eyebrow}>YOUR HOUSEHOLD FRIDGE</Text><Text style={s.heroTitle}>Hi, {data.me.user.firstName} 👋</Text><Text style={s.heroSub}>{attention.length ? `${attention.length} item${attention.length===1?' needs':'s need'} attention soon.` : 'Your food is looking fresh today.'}</Text><View style={s.statRow}><Stat number={fresh.length} caption="fresh items"/><Stat number={data.unread} caption="new alerts"/><Stat number={data.recipes.length} caption="recipe ideas"/></View></View>
    <Section title="Use these first" action={attention.length?'See fridge':null} onAction={()=>setTab('Fridge')}/>
    {attention.length ? attention.slice(0,5).map((i)=><FoodRow key={i.id} item={i} badge={label(i)} badgeColor={badgeColor(i)} onUse={()=>markItem(i,'used')} onDiscard={()=>markItem(i,'discard')}/>) : <Empty text="No urgent items. Nice fridge management!"/>}
    <Section title="Recipe ideas" action="Explore" onAction={()=>setTab('Recipes')}/>
    {data.recipes.slice(0,3).map((r)=><RecipeRow key={r.id} recipe={r} onPress={()=>setRecipe(r)}/>)}
    {!data.recipes.length && <Card><Text style={s.body}>Get ideas based on fresh ingredients in your fridge.</Text><Button title="Suggest recipes" onPress={suggest} busy={busy}/></Card>}
    <Button title={`View alerts${data.unread ? ` · ${data.unread} new` : ''}`} tone="light" onPress={openAlerts}/>
  </>;
  const removeUsedItem = (i) => run(async()=>{
    try { await request(`/items/${i.id}?outcome=consumed`,'DELETE'); }
    catch (e) {
      if (e.status === 404) await refresh();
      throw e;
    }
    setData(current=>current?{...current,items:current.items.filter(item=>item.id!==i.id)}:current);
    await refresh();
  },'Removed from your refrigerator and recorded as used.');
  const dismissWarning = (i) => run(async()=>{await request(`/items/${i.id}/dismiss`,'POST',{});await refresh();},'Warning dismissed for today. It will return tomorrow if still at risk.');
  const markItem = (i,action) => {
    if (action === 'used') {
      Alert.alert('Are you sure?', `Remove ${i.name} from your refrigerator and mark it as used?`, [
        { text:'No', style:'cancel' },
        { text:'Yes', style:'destructive', onPress:()=>removeUsedItem(i) },
      ]);
      return;
    }
    Alert.alert('Did you use this?', `${i.name} will be removed if you did. If you did not use it, it will stay in your refrigerator and this warning will return tomorrow if it is still at risk.`, [
      { text:'No, keep it', style:'cancel', onPress:()=>dismissWarning(i) },
      { text:'Yes, I used it', style:'destructive', onPress:()=>removeUsedItem(i) },
    ]);
  };
  function openAlerts(){setAlertsOpen(true);if(data.unread)run(async()=>{await request('/alerts/ack-all','POST',{});await refresh();});}
  const renderFridge = () => <>
    <Section title="My refrigerator" subtitle={`${data.items.length} items`} action="＋ Add" onAction={()=>setItemOpen(true)}/>
    <Input value={search} onChangeText={setSearch} placeholder="Search food in your fridge"/>
    {filteredItems.length ? filteredItems.map((i)=><FoodRow key={i.id} item={i} badge={label(i)} badgeColor={badgeColor(i)} onUse={()=>markItem(i,'used')} onDiscard={()=>markItem(i,'discard')}/>) : <Empty text="No matching ingredients. Add something to your fridge."/>}
    <Button title="＋ Add food" onPress={()=>setItemOpen(true)}/>
  </>;
  const renderRecipes = () => <>
    <Card><Text style={s.cardTitle}>Cook with what you have</Text><Text style={s.body}>Suggestions match fresh fridge ingredients. Chicken dishes appear only when chicken or manok is in your fridge.</Text><Button title="✨ Suggest recipes" onPress={suggest} busy={busy} disabled={!fresh.length}/></Card>
    <Section title="Suggestions that fit your fridge" subtitle={`${data.recipes.length} ideas`}/>
    {data.recipes.length ? data.recipes.map((r)=><RecipeRow key={r.id} recipe={r} onPress={()=>setRecipe(r)}/>) : <Empty text="Add fresh food, then tap Suggest recipes."/>}
  </>;
  const renderGroceries = () => <>
    <Section title="Grocery list" subtitle={`${data.grocery.list.filter(x=>x.done).length} of ${data.grocery.list.length} checked`}/>
    <View style={s.inline}><Input style={{flex:1}} value={groceryName} onChangeText={setGroceryName} placeholder="Add an item"/><Button style={{marginTop:0}} title="Add" onPress={()=>run(async()=>{await request('/grocery','POST',{name:groceryName});setGroceryName('');await refresh();})} disabled={!groceryName.trim()}/></View>
    {data.grocery.list.map((g)=><View key={g.id} style={s.groceryRow}><Pressable onPress={()=>run(async()=>{await request(`/grocery/${g.id}`,'PATCH',{done:!g.done});await refresh();})} style={[s.check,g.done&&s.checked]}><Text style={{color:C.white,fontWeight:'900'}}>{g.done?'✓':''}</Text></Pressable><View style={{flex:1}}><Text style={[s.cardTitle,g.done&&{textDecorationLine:'line-through',color:C.muted}]}>{g.name}</Text><Text style={s.muted}>{g.qty} {g.why ? `· ${g.why}` : ''}</Text></View><Pressable onPress={()=>run(async()=>{await request(`/grocery/${g.id}`,'DELETE');await refresh();})}><Text style={s.remove}>×</Text></Pressable></View>)}
    {data.grocery.suggestions?.length>0&&<Card><Text style={s.cardTitle}>Suggested for you</Text>{data.grocery.suggestions.slice(0,8).map((g)=><Text key={g.name} style={s.body}>• {g.name} — {g.why}</Text>)}<Button title="Add suggested items" tone="light" onPress={()=>run(async()=>{await request('/grocery/add-suggested','POST',{});await refresh();},'Added suggestions to your list.')}/></Card>}
    {!!data.grocery.list.some(x=>x.done)&&<Button title="Move checked items to fridge" onPress={()=>run(async()=>{await request('/grocery/move-bought','POST',{});await refresh();},'Moved purchased items into your fridge.')}/>}
    {!!data.grocery.list.length&&<Button title="Clear checked items" tone="light" onPress={()=>run(async()=>{await request('/grocery/clear-checked','POST',{});await refresh();})}/>}
  </>;
  const renderProfile = () => <>
    <Card><Text style={s.cardTitle}>{data.me.user.name}</Text><Text style={s.body}>{data.me.user.email}</Text><Text style={s.muted}>Household: {data.me.household.name}</Text><Text style={s.muted}>Invite code: {data.me.household.inviteCode}</Text></Card>
    <Card><Text style={s.cardTitle}>Freshness alerts</Text><Setting label="Email notifications" value={!!data.me.settings.email_on} onChange={(v)=>saveSettings({email_on:v})}/><Setting label="Phone push notifications" value={!!data.me.settings.push_on} onChange={(v)=>{if(v){setPushRegistered(false);saveSettings({push_on:true});}else saveSettings({push_on:false});}}/><Text style={s.muted}>Email: {data.me.emailEnabled?'configured':'not configured'} · Phone push: {pushRegistered?'enabled':data.me.pushEnabled?'waiting for device permission':'server not configured'}</Text></Card>
    <Card><Text style={s.cardTitle}>KeepFresh connections</Text><Text style={s.body}>Expiry estimates: {data.me.aiEnabled?'AI enabled':'household history and reference'}</Text><Text style={s.body}>Recipe ideas: fridge-matched, with offline suggestions available</Text></Card>
    <Button title="Log out" tone="light" onPress={logout}/>
  </>;
  const saveSettings = (patch) => run(async()=>{await request('/settings','PUT',patch);await refresh();},'Settings saved.');

  return <SafeAreaView style={s.screen} edges={['top','bottom']}><StatusBar barStyle="light-content" backgroundColor={C.green}/><View style={s.top}><View style={s.brandLine}><Image source={require('./assets/keepfresh-mark.png')} style={s.brandMark} resizeMode="contain"/><View><Text style={s.brand}>KeepFresh</Text><Text style={s.topSub}>{data.me.household.name}</Text></View></View><Pressable onPress={openAlerts} style={s.alertButton}><Text style={{fontSize:20}}>🔔</Text>{data.unread>0&&<View style={s.dot}/>}</Pressable></View>
    {(error||notice)&&<Pressable onPress={()=>{setError('');setNotice('')}} style={[s.message,error?s.errorBox:s.noticeBox]}><Text style={error?s.errorText:s.noticeText}>{error||notice}</Text></Pressable>}
    <ScrollView contentContainerStyle={s.content} refreshControl={<RefreshControl refreshing={busy} onRefresh={refresh} tintColor={C.green2}/>}>{tab==='Home'?renderHome():tab==='Fridge'?renderFridge():tab==='Recipes'?renderRecipes():tab==='Groceries'?renderGroceries():renderProfile()}</ScrollView>
    <View style={[s.tabs,{paddingBottom:Math.max(8,insets.bottom?0:8)}]}>{TABS.map(([name,icon])=><Pressable key={name} style={s.tab} onPress={()=>setTab(name)}><Text style={[s.tabIcon,tab===name&&s.tabOn]}>{icon}</Text><Text style={[s.tabText,tab===name&&s.tabOn]}>{name}</Text></Pressable>)}</View>
    <ItemModal visible={itemOpen} onClose={()=>setItemOpen(false)} item={item} setItem={setItem} catalog={data.catalog} save={addItem} busy={busy} request={request}/>
    <RecipeModal recipe={recipe} onClose={()=>setRecipe(null)} request={request} reload={refresh} setNotice={setNotice}/>
    <AlertsModal visible={alertsOpen} onClose={()=>setAlertsOpen(false)} alerts={data.alerts}/>
  </SafeAreaView>;
}

function AuthScreen({mode,setMode,fields,setFields,submit,busy,error,notice}) {
 const set=(key,value)=>setFields((v)=>({...v,[key]:value}));
 const field=(key,label,opts={})=><Input key={key} label={label} value={fields[key]} onChangeText={(v)=>set(key,v)} placeholder={label} {...opts}/>;
 return <SafeAreaView style={s.authScreen} edges={['top','bottom']}><KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==='ios'?'padding':undefined}><ScrollView contentContainerStyle={s.authContent} keyboardShouldPersistTaps="handled"><Image source={require('./assets/keepfresh-logo.png')} style={s.authLogo} resizeMode="contain"/><Text style={s.heroTitleDark}>{mode==='login'?'Welcome back':mode==='register'?'Create an account':'Verify your email'}</Text><Text style={s.body}>{mode==='verify'?'Enter the 6-digit code sent to your email.': 'Keep your household food fresh and find something good to cook.'}</Text>{error? <Text style={s.errorText}>{error}</Text>:null}{notice?<Text style={s.noticeText}>{notice}</Text>:null}
 {mode==='register'&&<>{field('firstName','First name')}{field('middleName','Middle name (optional)')}{field('lastName','Last name')}</>}{field('email','Email',{keyboardType:'email-address',autoCapitalize:'none'})}{mode!=='verify'&&field('password','Password',{secureTextEntry:true})}{mode==='register'&&<>{field('householdName','Household name (optional)')}{field('inviteCode','Invite code (optional)')}</>}{mode==='verify'&&field('code','6-digit code',{keyboardType:'number-pad',maxLength:6})}
 <Button title={busy?'Please wait…':mode==='login'?'Log in':mode==='register'?'Create account':'Verify email'} onPress={submit} busy={busy}/><Pressable onPress={()=>{setMode(mode==='login'?'register':'login');}}><Text style={s.link}>{mode==='login'?"New to KeepFresh? Create an account":'Back to log in'}</Text></Pressable></ScrollView></KeyboardAvoidingView></SafeAreaView>;
}
function ItemModal({visible,onClose,item,setItem,catalog,save,busy,request}) {
 const set=(k,v)=>setItem((x)=>({...x,[k]:v}));
 return <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}><View style={s.modalShade}><KeyboardAvoidingView behavior={Platform.OS==='ios'?'padding':undefined} style={s.modalCard}><ScrollView keyboardShouldPersistTaps="handled"><View style={s.modalHead}><Text style={s.modalTitle}>Add food</Text><Pressable onPress={onClose}><Text style={s.remove}>×</Text></Pressable></View><Input label="Food name" placeholder="e.g. chicken breast" value={item.name} onChangeText={(v)=>set('name',v)}/><Input label="Quantity" placeholder="1" value={item.qty} onChangeText={(v)=>set('qty',v)}/><Text style={s.fieldLabel}>Category</Text><ScrollView horizontal showsHorizontalScrollIndicator={false}>{catalog.map((c)=><Chip key={c.category} selected={item.category===c.category} label={`${c.emoji||'🧺'} ${c.category}`} onPress={()=>set('category',c.category)}/>)}</ScrollView><Input label="Date bought (YYYY-MM-DD)" value={item.bought} onChangeText={(v)=>set('bought',v)}/><Input label="Expiration date (optional, YYYY-MM-DD)" value={item.expires} onChangeText={(v)=>set('expires',v)} placeholder="Leave blank to estimate"/><Button title="Save to fridge" onPress={save} busy={busy} disabled={!item.name.trim()}/></ScrollView></KeyboardAvoidingView></View></Modal>;
}
function RecipeModal({recipe,onClose,request,reload,setNotice}) {
 const [busy,setBusy]=useState(false); if(!recipe)return null;
 const action=async(fn,msg)=>{setBusy(true);try{const x=await fn();await reload();setNotice(msg||'Done.');if(msg?.startsWith('Cooked'))onClose();return x;}catch(e){Alert.alert('KeepFresh',e.message);}finally{setBusy(false);}};
 return <Modal visible={!!recipe} animationType="slide" transparent onRequestClose={onClose}><View style={s.modalShade}><View style={s.modalCard}><ScrollView><View style={s.modalHead}><Text style={s.modalTitle}>{recipe.emoji} {recipe.name}</Text><Pressable onPress={onClose}><Text style={s.remove}>×</Text></Pressable></View><Text style={s.muted}>⏱ {recipe.time} · {recipe.ready}/{recipe.total} ingredients in fridge</Text><Section title="Ingredients"/>{recipe.ingredients.map((g,i)=><Text key={`${g.key}-${i}`} style={s.body}>• {g.amount} {g.key}{g.have?'  ✓':''}</Text>)}<Section title="Steps"/>{recipe.steps.map((st,i)=><View key={i} style={s.step}><Text style={s.stepNo}>{i+1}</Text><Text style={[s.body,{flex:1}]}>{st}</Text></View>)}<Button title="Add missing ingredients" tone="light" busy={busy} onPress={()=>action(()=>request(`/grocery/add-missing`,'POST',{recipeId:recipe.id}),'Missing ingredients added to grocery list.')}/><Button title="Cooked this recipe" busy={busy} onPress={()=>action(()=>request(`/recipes/${recipe.id}/cook`,'POST',{}),'Cooked. Fridge inventory updated.')}/></ScrollView></View></View></Modal>;
}
function AlertsModal({visible,onClose,alerts}) { return <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}><View style={s.modalShade}><View style={s.modalCard}><View style={s.modalHead}><Text style={s.modalTitle}>Alerts</Text><Pressable onPress={onClose}><Text style={s.remove}>×</Text></Pressable></View><ScrollView>{alerts.length?alerts.map(a=><Card key={a.id}><Text style={s.cardTitle}>{a.level} · {a.message}</Text><Text style={s.muted}>{String(a.created_at||'')}</Text></Card>):<Empty text="No alerts right now."/>}</ScrollView></View></View></Modal>; }
function Setting({label,value,onChange}) { return <View style={s.setting}><Text style={s.body}>{label}</Text><Switch value={!!value} onValueChange={onChange} trackColor={{true:C.green2}}/></View>; }
function FoodRow({item,badge,badgeColor,onUse,onDiscard}) { return <Card><View style={s.rowTop}><View style={{flex:1}}><Text style={s.cardTitle}>{categoryEmoji(item.category)} {item.name}</Text><Text style={s.muted}>{item.category} · {item.qty} · expires {item.expires}</Text></View><Text style={[s.pill,{color:badgeColor,borderColor:badgeColor}]}>{badge}</Text></View><View style={s.actionRow}><Pressable onPress={onUse}><Text style={s.link}>Mark used</Text></Pressable><Pressable onPress={onDiscard}><Text style={s.dangerLink}>Discard</Text></Pressable></View></Card>; }
function RecipeRow({recipe,onPress}) { return <Pressable onPress={onPress} style={s.recipeRow}><Text style={s.recipeEmoji}>{recipe.emoji}</Text><View style={{flex:1}}><Text style={s.cardTitle}>{recipe.name}</Text><Text style={s.muted}>{recipe.ready}/{recipe.total} ingredients · {recipe.time}</Text><Text style={s.muted}>{recipe.soon?.length?`Use soon: ${recipe.soon.join(', ')}`:'Fridge match'}</Text></View><Text style={s.arrow}>›</Text></Pressable>; }
function Section({title,subtitle,action,onAction}) { return <View style={s.section}><View><Text style={s.sectionTitle}>{title}</Text>{subtitle?<Text style={s.muted}>{subtitle}</Text>:null}</View>{action?<Pressable onPress={onAction}><Text style={s.link}>{action}</Text></Pressable>:null}</View>; }
function Card({children}) { return <View style={s.card}>{children}</View>; }
function Stat({number,caption}) { return <View style={s.stat}><Text style={s.statNumber}>{number}</Text><Text style={s.statCaption}>{caption}</Text></View>; }
function Empty({text}) { return <View style={s.empty}><Text style={s.body}>{text}</Text></View>; }
function Button({title,onPress,busy,disabled,tone='primary',style}) { return <Pressable onPress={onPress} disabled={busy||disabled} style={[s.button,tone==='light'&&s.buttonLight,(busy||disabled)&&s.buttonDisabled,style]}><Text style={[s.buttonText,tone==='light'&&s.buttonTextLight]}>{busy?<ActivityIndicator color={tone==='light'?C.green:C.white}/>:title}</Text></Pressable>; }
function Input({label,value,onChangeText,style,...props}) { return <View style={[{marginBottom:12},style]}>{label?<Text style={s.fieldLabel}>{label}</Text>:null}<TextInput value={value} onChangeText={onChangeText} placeholderTextColor="#92998a" style={s.input} {...props}/></View>; }
function Chip({label,selected,onPress}) { return <Pressable onPress={onPress} style={[s.chip,selected&&s.chipOn]}><Text style={[s.chipText,selected&&{color:C.white}]}>{label}</Text></Pressable>; }
function Splash({label,action}) { return <SafeAreaView style={s.splash} edges={['top','bottom']}><Image source={require('./assets/keepfresh-logo.png')} style={s.splashLogo} resizeMode="contain"/><Text style={s.body}>{label}</Text>{action&&<Button title="Try again" onPress={action}/>}</SafeAreaView>; }
function categoryEmoji(category='') { return ({Poultry:'🍗','Ground meat':'🥩','Pork or beef cuts':'🥓','Fish & seafood':'🐟','Leafy vegetables':'🥬',Dairy:'🥛',Eggs:'🥚'})[category]||'🧺'; }



const s=StyleSheet.create({
 screen:{flex:1,backgroundColor:C.cream}, top:{minHeight:72,backgroundColor:C.green,paddingHorizontal:18,flexDirection:'row',justifyContent:'space-between',alignItems:'center'},brandLine:{flexDirection:'row',alignItems:'center',gap:10},brandMark:{width:43,height:43},brand:{fontSize:21,fontWeight:'900',color:C.white,letterSpacing:-.5},brandDark:{fontSize:29,fontWeight:'900',color:C.green,marginBottom:16},authLogo:{width:'100%',height:205,alignSelf:'center',marginBottom:8},splashLogo:{width:'85%',height:250,marginBottom:16},topSub:{color:'#dce5c6',fontSize:12,marginTop:1},alertButton:{width:44,height:44,borderRadius:16,backgroundColor:'#ffffff20',alignItems:'center',justifyContent:'center'},dot:{position:'absolute',right:7,top:7,width:9,height:9,borderRadius:5,backgroundColor:'#f1bd51'},
 content:{paddingHorizontal:16,paddingTop:16,paddingBottom:26},hero:{backgroundColor:C.green,borderRadius:26,padding:22,marginBottom:22},eyebrow:{color:'#dce5c6',fontSize:10,fontWeight:'800',letterSpacing:1.6},heroTitle:{fontSize:28,fontWeight:'900',color:C.white,marginTop:10},heroSub:{fontSize:15,color:'#edf2dd',marginTop:5},statRow:{flexDirection:'row',marginTop:22,backgroundColor:'#ffffff14',borderRadius:18,paddingVertical:12},stat:{flex:1,alignItems:'center'},statNumber:{color:C.white,fontSize:23,fontWeight:'900'},statCaption:{color:'#dce5c6',fontSize:11,marginTop:3},
 section:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginTop:14,marginBottom:10},sectionTitle:{fontSize:18,fontWeight:'900',color:C.ink},card:{backgroundColor:C.white,borderColor:C.line,borderWidth:1,borderRadius:19,padding:15,marginBottom:11},cardTitle:{fontSize:15,fontWeight:'800',color:C.ink},body:{fontSize:14,lineHeight:21,color:C.ink,marginTop:5},muted:{fontSize:12,color:C.muted,marginTop:4,lineHeight:17},rowTop:{flexDirection:'row',alignItems:'flex-start',gap:10},pill:{fontSize:10,fontWeight:'800',borderWidth:1,borderRadius:20,paddingVertical:5,paddingHorizontal:8,overflow:'hidden'},actionRow:{flexDirection:'row',gap:24,marginTop:12,borderTopWidth:1,borderColor:C.line,paddingTop:10},link:{fontSize:13,color:C.green2,fontWeight:'800',paddingVertical:5},dangerLink:{fontSize:13,color:C.red,fontWeight:'800',paddingVertical:5},
 button:{backgroundColor:C.green,borderRadius:15,minHeight:48,paddingHorizontal:16,paddingVertical:13,alignItems:'center',justifyContent:'center',marginTop:9},buttonLight:{backgroundColor:C.soft},buttonDisabled:{opacity:.48},buttonText:{color:C.white,fontWeight:'900',fontSize:14},buttonTextLight:{color:C.green},tabs:{backgroundColor:C.white,borderTopWidth:1,borderTopColor:C.line,flexDirection:'row',paddingTop:9,paddingBottom:8},tab:{flex:1,alignItems:'center',gap:3},tabIcon:{fontSize:19,color:'#919889'},tabText:{fontSize:10,color:C.muted,fontWeight:'700'},tabOn:{color:C.green,fontWeight:'900'},recipeRow:{flexDirection:'row',alignItems:'center',gap:12,backgroundColor:C.white,borderWidth:1,borderColor:C.line,borderRadius:18,padding:14,marginBottom:9},recipeEmoji:{fontSize:28,width:42,textAlign:'center'},arrow:{fontSize:25,color:C.green2},
 inline:{flexDirection:'row',alignItems:'flex-start',gap:8},groceryRow:{flexDirection:'row',alignItems:'center',gap:12,padding:14,backgroundColor:C.white,borderWidth:1,borderColor:C.line,borderRadius:16,marginBottom:8},check:{height:26,width:26,borderRadius:8,borderWidth:1.5,borderColor:C.green2,alignItems:'center',justifyContent:'center'},checked:{backgroundColor:C.green2},remove:{fontSize:28,color:C.muted,paddingHorizontal:8},
 input:{backgroundColor:C.white,borderWidth:1,borderColor:C.line,borderRadius:13,minHeight:48,paddingHorizontal:13,paddingVertical:10,fontSize:15,color:C.ink},fieldLabel:{fontSize:12,fontWeight:'800',color:C.ink,marginBottom:6,marginTop:3},chip:{backgroundColor:C.soft,paddingHorizontal:12,paddingVertical:9,borderRadius:20,marginRight:7,marginBottom:6},chipOn:{backgroundColor:C.green2},chipText:{fontSize:12,fontWeight:'700',color:C.green},
 authScreen:{flex:1,backgroundColor:C.cream},authContent:{padding:22,paddingTop:16,paddingBottom:28},heroTitleDark:{fontSize:25,fontWeight:'900',color:C.ink,marginTop:7},message:{padding:11,borderRadius:12,marginTop:8},errorBox:{backgroundColor:'#fde7e2'},noticeBox:{backgroundColor:'#ebf2dc'},errorText:{color:C.red,fontSize:13,marginVertical:8},noticeText:{color:C.green2,fontSize:13,marginVertical:8},linkText:{color:C.green2},
 modalShade:{flex:1,backgroundColor:'#10170dcc',justifyContent:'flex-end'},modalCard:{backgroundColor:C.cream,borderTopLeftRadius:26,borderTopRightRadius:26,padding:18,paddingTop:22,paddingBottom:Platform.OS==='ios'?34:24,maxHeight:'92%'},modalHead:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginBottom:12},modalTitle:{fontSize:21,fontWeight:'900',color:C.ink,flex:1},step:{flexDirection:'row',alignItems:'flex-start',gap:10,marginTop:12},stepNo:{backgroundColor:C.green2,color:C.white,fontWeight:'900',overflow:'hidden',borderRadius:13,width:26,height:26,textAlign:'center',textAlignVertical:'center',paddingTop:4},setting:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingVertical:5},empty:{padding:20,backgroundColor:C.white,borderColor:C.line,borderWidth:1,borderRadius:16,marginBottom:12},splash:{flex:1,backgroundColor:C.cream,alignItems:'center',justifyContent:'center',padding:24}
});

