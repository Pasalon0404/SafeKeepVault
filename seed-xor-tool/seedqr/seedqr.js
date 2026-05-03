import QRCode from 'qrcode';

// ==========================================
// 1. BIP-39 WORDLIST
// ==========================================
// Paste your correctly formatted array items below.
const bip39Wordlist = ["abandon","ability","able","about","above","absent","absorb","abstract","absurd","abuse","access","accident","account","accuse","achieve","acid","acoustic","acquire","across","act","action","actor","actress","actual","adapt","add","addict","address","adjust","admit","adult","advance","advice","aerobic","affair","afford","afraid","again","age","agent","agree","ahead","aim","air","airport","aisle","alarm","album","alcohol","alert","alien","all","alley","allow","almost","alone","alpha","already","also","alter","always","amateur","amazing","among","amount","amused","analyst","anchor","ancient","anger","angle","angry","animal","ankle","announce","annual","another","answer","antenna","antique","anxiety","any","apart","apology","appear","apple","approve","april","arch","arctic","area","arena","argue","arm","armed","armor","army","around","arrange","arrest","arrive","arrow","art","artefact","artist","artwork","ask","aspect","assault","asset","assist","assume","asthma","athlete","atom","attack","attend","attitude","attract","auction","audit","august","aunt","author","auto","autumn","average","avocado","avoid","awake","aware","away","awesome","awful","awkward","axis","baby","bachelor","bacon","badge","bag","balance","balcony","ball","bamboo","banana","banner","bar","barely","bargain","barrel","base","basic","basket","battle","beach","bean","beauty","because","become","beef","before","begin","behave","behind","believe","below","belt","bench","benefit","best","betray","better","between","beyond","bicycle","bid","bike","bind","biology","bird","birth","bitter","black","blade","blame","blanket","blast","bleak","bless","blind","blood","blossom","blouse","blue","blur","blush","board","boat","body","boil","bomb","bone","bonus","book","boost","border","boring","borrow","boss","bottom","bounce","box","boy","bracket","brain","brand","brass","brave","bread","breeze","brick","bridge","brief","bright","bring","brisk","broccoli","broken","bronze","broom","brother","brown","brush","bubble","buddy","budget","buffalo","build","bulb","bulk","bullet","bundle","bunker","burden","burger","burst","bus","business","busy","butter","buyer","buzz","cabbage","cabin","cable","cactus","cage","cake","call","calm","camera","camp","can","canal","cancel","candy","cannon","canoe","canvas","canyon","capable","capital","captain","car","carbon","card","cargo","carpet","carry","cart","case","cash","casino","castle","casual","cat","catalog","catch","category","cattle","caught","cause","caution","cave","ceiling","celery","cement","census","century","cereal","certain","chair","chalk","champion","change","chaos","chapter","charge","chase","chat","cheap","check","cheese","chef","cherry","chest","chicken","chief","child","chimney","choice","choose","chronic","chuckle","chunk","churn","cigar","cinnamon","circle","citizen","city","civil","claim","clap","clarify","claw","clay","clean","clerk","clever","click","client","cliff","climb","clinic","clip","clock","clog","close","cloth","cloud","clown","club","clump","cluster","clutch","coach","coast","coconut","code","coffee","coil","coin","collect","color","column","combine","come","comfort","comic","common","company","concert","conduct","confirm","congress","connect","consider","control","convince","cook","cool","copper","copy","coral","core","corn","correct","cost","cotton","couch","country","couple","course","cousin","cover","coyote","crack","cradle","craft","cram","crane","crash","crater","crawl","crazy","cream","credit","creek","crew","cricket","crime","crisp","critic","crop","cross","crouch","crowd","crucial","cruel","cruise","crumble","crunch","crush","cry","crystal","cube","culture","cup","cupboard","curious","current","curtain","curve","cushion","custom","cute","cycle","dad","damage","damp","dance","danger","daring","dash","daughter","dawn","day","deal","debate","debris","decade","december","decide","decline","decorate","decrease","deer","defense","define","defy","degree","delay","deliver","demand","demise","denial","dentist","deny","depart","depend","deposit","depth","deputy","derive","describe","desert","design","desk","despair","destroy","detail","detect","develop","device","devote","diagram","dial","diamond","diary","dice","diesel","diet","differ","digital","dignity","dilemma","dinner","dinosaur","direct","dirt","disagree","discover","disease","dish","dismiss","disorder","display","distance","divert","divide","divorce","dizzy","doctor","document","dog","doll","dolphin","domain","donate","donkey","donor","door","dose","double","dove","draft","dragon","drama","drastic","draw","dream","dress","drift","drill","drink","drip","drive","drop","drum","dry","duck","dumb","dune","during","dust","dutch","duty","dwarf","dynamic","eager","eagle","early","earn","earth","easily","east","easy","echo","ecology","economy","edge","edit","educate","effort","egg","eight","either","elbow","elder","electric","elegant","element","elephant","elevator","elite","else","embark","embody","embrace","emerge","emotion","employ","empower","empty","enable","enact","end","endless","endorse","enemy","energy","enforce","engage","engine","enhance","enjoy","enlist","enough","enrich","enroll","ensure","enter","entire","entry","envelope","episode","equal","equip","era","erase","erode","erosion","error","erupt","escape","essay","essence","estate","eternal","ethics","evidence","evil","evoke","evolve","exact","example","excess","exchange","excite","exclude","excuse","execute","exercise","exhaust","exhibit","exile","exist","exit","exotic","expand","expect","expire","explain","expose","express","extend","extra","eye","eyebrow","fabric","face","faculty","fade","faint","faith","fall","false","fame","family","famous","fan","fancy","fantasy","farm","fashion","fat","fatal","father","fatigue","fault","favorite","feature","february","federal","fee","feed","feel","female","fence","festival","fetch","fever","few","fiber","fiction","field","figure","file","film","filter","final","find","fine","finger","finish","fire","firm","first","fiscal","fish","fit","fitness","fix","flag","flame","flash","flat","flavor","flee","flight","flip","float","flock","floor","flower","fluid","flush","fly","foam","focus","fog","foil","fold","follow","food","foot","force","forest","forget","fork","fortune","forum","forward","fossil","foster","found","fox","fragile","frame","frequent","fresh","friend","fringe","frog","front","frost","frown","frozen","fruit","fuel","fun","funny","furnace","fury","future","gadget","gain","galaxy","gallery","game","gap","garage","garbage","garden","garlic","garment","gas","gasp","gate","gather","gauge","gaze","general","genius","genre","gentle","genuine","gesture","ghost","giant","gift","giggle","ginger","giraffe","girl","give","glad","glance","glare","glass","glide","glimpse","globe","gloom","glory","glove","glow","glue","goat","goddess","gold","good","goose","gorilla","gospel","gossip","govern","gown","grab","grace","grain","grant","grape","grass","gravity","great","green","grid","grief","grit","grocery","group","grow","grunt","guard","guess","guide","guilt","guitar","gun","gym","habit","hair","half","hammer","hamster","hand","happy","harbor","hard","harsh","harvest","hat","have","hawk","hazard","head","health","heart","heavy","hedgehog","height","hello","helmet","help","hen","hero","hidden","high","hill","hint","hip","hire","history","hobby","hockey","hold","hole","holiday","hollow","home","honey","hood","hope","horn","horror","horse","hospital","host","hotel","hour","hover","hub","huge","human","humble","humor","hundred","hungry","hunt","hurdle","hurry","hurt","husband","hybrid","ice","icon","idea","identify","idle","ignore","ill","illegal","illness","image","imitate","immense","immune","impact","impose","improve","impulse","inch","include","income","increase","index","indicate","indoor","industry","infant","inflict","inform","inhale","inherit","initial","inject","injury","inmate","inner","innocent","input","inquiry","insane","insect","inside","inspire","install","intact","interest","into","invest","invite","involve","iron","island","isolate","issue","item","ivory","jacket","jaguar","jar","jazz","jealous","jeans","jelly","jewel","job","join","joke","journey","joy","judge","juice","jump","jungle","junior","junk","just","kangaroo","keen","keep","ketchup","key","kick","kid","kidney","kind","kingdom","kiss","kit","kitchen","kite","kitten","kiwi","knee","knife","knock","know","lab","label","labor","ladder","lady","lake","lamp","language","laptop","large","later","latin","laugh","laundry","lava","law","lawn","lawsuit","layer","lazy","leader","leaf","learn","leave","lecture","left","leg","legal","legend","leisure","lemon","lend","length","lens","leopard","lesson","letter","level","liar","liberty","library","license","life","lift","light","like","limb","limit","link","lion","liquid","list","little","live","lizard","load","loan","lobster","local","lock","logic","lonely","long","loop","lottery","loud","lounge","love","loyal","lucky","luggage","lumber","lunar","lunch","luxury","lyrics","machine","mad","magic","magnet","maid","mail","main","major","make","mammal","man","manage","mandate","mango","mansion","manual","maple","marble","march","margin","marine","market","marriage","mask","mass","master","match","material","math","matrix","matter","maximum","maze","meadow","mean","measure","meat","mechanic","medal","media","melody","melt","member","memory","mention","menu","mercy","merge","merit","merry","mesh","message","metal","method","middle","midnight","milk","million","mimic","mind","minimum","minor","minute","miracle","mirror","misery","miss","mistake","mix","mixed","mixture","mobile","model","modify","mom","moment","monitor","monkey","monster","month","moon","moral","more","morning","mosquito","mother","motion","motor","mountain","mouse","move","movie","much","muffin","mule","multiply","muscle","museum","mushroom","music","must","mutual","myself","mystery","myth","naive","name","napkin","narrow","nasty","nation","nature","near","neck","need","negative","neglect","neither","nephew","nerve","nest","net","network","neutral","never","news","next","nice","night","noble","noise","nominee","noodle","normal","north","nose","notable","note","nothing","notice","novel","now","nuclear","number","nurse","nut","oak","obey","object","oblige","obscure","observe","obtain","obvious","occur","ocean","october","odor","off","offer","office","often","oil","okay","old","olive","olympic","omit","once","one","onion","online","only","open","opera","opinion","oppose","option","orange","orbit","orchard","order","ordinary","organ","orient","original","orphan","ostrich","other","outdoor","outer","output","outside","oval","oven","over","own","owner","oxygen","oyster","ozone","pact","paddle","page","pair","palace","palm","panda","panel","panic","panther","paper","parade","parent","park","parrot","party","pass","patch","path","patient","patrol","pattern","pause","pave","payment","peace","peanut","pear","peasant","pelican","pen","penalty","pencil","people","pepper","perfect","permit","person","pet","phone","photo","phrase","physical","piano","picnic","picture","piece","pig","pigeon","pill","pilot","pink","pioneer","pipe","pistol","pitch","pizza","place","planet","plastic","plate","play","please","pledge","pluck","plug","plunge","poem","poet","point","polar","pole","police","pond","pony","pool","popular","portion","position","possible","post","potato","pottery","poverty","powder","power","practice","praise","predict","prefer","prepare","present","pretty","prevent","price","pride","primary","print","priority","prison","private","prize","problem","process","produce","profit","program","project","promote","proof","property","prosper","protect","proud","provide","public","pudding","pull","pulp","pulse","pumpkin","punch","pupil","puppy","purchase","purity","purpose","purse","push","put","puzzle","pyramid","quality","quantum","quarter","question","quick","quit","quiz","quote","rabbit","raccoon","race","rack","radar","radio","rail","rain","raise","rally","ramp","ranch","random","range","rapid","rare","rate","rather","raven","raw","razor","ready","real","reason","rebel","rebuild","recall","receive","recipe","record","recycle","reduce","reflect","reform","refuse","region","regret","regular","reject","relax","release","relief","rely","remain","remember","remind","remove","render","renew","rent","reopen","repair","repeat","replace","report","require","rescue","resemble","resist","resource","response","result","retire","retreat","return","reunion","reveal","review","reward","rhythm","rib","ribbon","rice","rich","ride","ridge","rifle","right","rigid","ring","riot","ripple","risk","ritual","rival","river","road","roast","robot","robust","rocket","romance","roof","rookie","room","rose","rotate","rough","round","route","royal","rubber","rude","rug","rule","run","runway","rural","sad","saddle","sadness","safe","sail","salad","salmon","salon","salt","salute","same","sample","sand","satisfy","satoshi","sauce","sausage","save","say","scale","scan","scare","scatter","scene","scheme","school","science","scissors","scorpion","scout","scrap","screen","script","scrub","sea","search","season","seat","second","secret","section","security","seed","seek","segment","select","sell","seminar","senior","sense","sentence","series","service","session","settle","setup","seven","shadow","shaft","shallow","share","shed","shell","sheriff","shield","shift","shine","ship","shiver","shock","shoe","shoot","shop","short","shoulder","shove","shrimp","shrug","shuffle","shy","sibling","sick","side","siege","sight","sign","silent","silk","silly","silver","similar","simple","since","sing","siren","sister","situate","six","size","skate","sketch","ski","skill","skin","skirt","skull","slab","slam","sleep","slender","slice","slide","slight","slim","slogan","slot","slow","slush","small","smart","smile","smoke","smooth","snack","snake","snap","sniff","snow","soap","soccer","social","sock","soda","soft","solar","soldier","solid","solution","solve","someone","song","soon","sorry","sort","soul","sound","soup","source","south","space","spare","spatial","spawn","speak","special","speed","spell","spend","sphere","spice","spider","spike","spin","spirit","split","spoil","sponsor","spoon","sport","spot","spray","spread","spring","spy","square","squeeze","squirrel","stable","stadium","staff","stage","stairs","stamp","stand","start","state","stay","steak","steel","stem","step","stereo","stick","still","sting","stock","stomach","stone","stool","story","stove","strategy","street","strike","strong","struggle","student","stuff","stumble","style","subject","submit","subway","success","such","sudden","suffer","sugar","suggest","suit","summer","sun","sunny","sunset","super","supply","supreme","sure","surface","surge","surprise","surround","survey","suspect","sustain","swallow","swamp","swap","swarm","swear","sweet","swift","swim","swing","switch","sword","symbol","symptom","syrup","system","table","tackle","tag","tail","talent","talk","tank","tape","target","task","taste","tattoo","taxi","teach","team","tell","ten","tenant","tennis","tent","term","test","text","thank","that","theme","then","theory","there","they","thing","this","thought","three","thrive","throw","thumb","thunder","ticket","tide","tiger","tilt","timber","time","tiny","tip","tired","tissue","title","toast","tobacco","today","toddler","toe","together","toilet","token","tomato","tomorrow","tone","tongue","tonight","tool","tooth","top","topic","topple","torch","tornado","tortoise","toss","total","tourist","toward","tower","town","toy","track","trade","traffic","tragic","train","transfer","trap","trash","travel","tray","treat","tree","trend","trial","tribe","trick","trigger","trim","trip","trophy","trouble","truck","true","truly","trumpet","trust","truth","try","tube","tuition","tumble","tuna","tunnel","turkey","turn","turtle","twelve","twenty","twice","twin","twist","two","type","typical","ugly","umbrella","unable","unaware","uncle","uncover","under","undo","unfair","unfold","unhappy","uniform","unique","unit","universe","unknown","unlock","until","unusual","unveil","update","upgrade","uphold","upon","upper","upset","urban","urge","usage","use","used","useful","useless","usual","utility","vacant","vacuum","vague","valid","valley","valve","van","vanish","vapor","various","vast","vault","vehicle","velvet","vendor","venture","venue","verb","verify","version","very","vessel","veteran","viable","vibrant","vicious","victory","video","view","village","vintage","violin","virtual","virus","visa","visit","visual","vital","vivid","vocal","voice","void","volcano","volume","vote","voyage","wage","wagon","wait","walk","wall","walnut","want","warfare","warm","warrior","wash","wasp","waste","water","wave","way","wealth","weapon","wear","weasel","weather","web","wedding","weekend","weird","welcome","west","wet","whale","what","wheat","wheel","when","where","whip","whisper","wide","width","wife","wild","will","win","window","wine","wing","wink","winner","winter","wire","wisdom","wise","wish","witness","wolf","woman","wonder","wood","wool","word","work","world","worry","worth","wrap","wreck","wrestle","wrist","write","wrong","yard","year","yellow","you","young","youth","zebra","zero","zone","zoo"];

    // ... PASTE YOUR 2048 WORDS HERE ...


let currentNumericSeed = ""; 

// === UI & TABS HELPERS ===
document.getElementById('theme-btn').addEventListener('click', (e) => {
    e.preventDefault();
    const html = document.documentElement;
    if (html.getAttribute('data-theme') === 'light') {
        html.removeAttribute('data-theme');
        localStorage.setItem('safekeepTheme', 'dark');
        document.getElementById('theme-btn').innerText = '☀️';
    } else {
        html.setAttribute('data-theme', 'light');
        localStorage.setItem('safekeepTheme', 'light');
        document.getElementById('theme-btn').innerText = '🌙';
    }
});
if (localStorage.getItem('safekeepTheme') === 'light') document.getElementById('theme-btn').innerText = '🌙';

document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        e.target.classList.add('active');
        document.getElementById(e.target.getAttribute('data-target')).classList.add('active');
    });
});

// === SEED GRID & AUTOCOMPLETE LOGIC ===
function closeAllLists(elmnt) {
    const x = document.querySelectorAll('.autocomplete-list');
    const inputs = document.querySelectorAll('.word-input');
    for (let i = 0; i < x.length; i++) {
        if (elmnt !== x[i] && elmnt !== inputs) x[i].parentNode.removeChild(x[i]);
    }
}
document.addEventListener("click", e => closeAllLists(e.target));

window.validateWord = function(input) {
    const val = input.value.trim().toLowerCase();
    const wordBox = input.closest('.word-box');
    if (val === '') { wordBox.classList.remove('invalid'); return false; }
    if (bip39Wordlist && bip39Wordlist.length > 0 && !bip39Wordlist.includes(val)) {
        wordBox.classList.add('invalid'); return false;
    } else {
        wordBox.classList.remove('invalid'); return true;
    }
};

window.updateSeedGrid = function() {
    const length = parseInt(document.querySelector('input[name="seedLength"]:checked').value);
    const container = document.getElementById('seed-grid-container');
    container.innerHTML = '';
    for (let i = 1; i <= length; i++) {
        container.innerHTML += `
            <div class="word-box">
                <span>${i}.</span>
                <input type="text" class="word-input" autocomplete="off">
            </div>
        `;
    }
    attachAutocompleteEvents();
    document.getElementById('qr-output').style.display = 'none';
};

function attachAutocompleteEvents() {
    const inputs = document.querySelectorAll('.word-input');
    inputs.forEach((input, index) => {
        input.addEventListener('input', function() {
            let val = this.value.toLowerCase();
            closeAllLists();
            window.validateWord(this);
            if (!val || !bip39Wordlist || bip39Wordlist.length === 0) return false;

            let list = document.createElement("DIV");
            list.setAttribute("class", "autocomplete-list");
            list.style.display = "block";
            this.parentNode.appendChild(list);

            let matches = 0;
            for (let i = 0; i < bip39Wordlist.length; i++) {
                if (bip39Wordlist[i].substr(0, val.length) === val) {
                    let item = document.createElement("DIV");
                    item.setAttribute("class", "autocomplete-item");
                    item.innerHTML = "<strong>" + bip39Wordlist[i].substr(0, val.length) + "</strong>" + bip39Wordlist[i].substr(val.length) + "<input type='hidden' value='" + bip39Wordlist[i] + "'>";
                    item.addEventListener("click", function(e) {
                        input.value = this.getElementsByTagName("input")[0].value;
                        window.validateWord(input);
                        closeAllLists();
                        if (index < inputs.length - 1) inputs[index + 1].focus();
                    });
                    list.appendChild(item);
                    matches++;
                }
            }
            if (matches > 0) list.firstChild.classList.add('active-suggestion');
        });

        input.addEventListener('keydown', function(e) {
            let list = this.parentNode.querySelector('.autocomplete-list');
            if (list && list.style.display === 'block' && e.key === 'Tab') {
                e.preventDefault(); 
                const firstItem = list.firstChild;
                if (firstItem) {
                    this.value = firstItem.getElementsByTagName("input")[0].value; 
                    window.validateWord(this);
                    closeAllLists();
                    if (index < inputs.length - 1) inputs[index + 1].focus();
                }
            }
        });

        input.addEventListener('paste', function(e) {
            e.preventDefault();
            const pasteData = (e.clipboardData || window.clipboardData).getData('text');
            const words = pasteData.trim().split(/[\s\n]+/); 
            
            if (words.length === 24 && document.querySelector('input[name="seedLength"][value="12"]').checked) {
                document.querySelector('input[name="seedLength"][value="24"]').checked = true;
                window.updateSeedGrid();
                setTimeout(() => fillPastedWords(words, 0), 10);
                return;
            } else if (words.length === 12 && document.querySelector('input[name="seedLength"][value="24"]').checked) {
                document.querySelector('input[name="seedLength"][value="12"]').checked = true;
                window.updateSeedGrid();
                setTimeout(() => fillPastedWords(words, 0), 10);
                return;
            }
            fillPastedWords(words, index);
        });
    });
}

function fillPastedWords(words, startIndex) {
    const inputs = document.querySelectorAll('.word-input');
    words.forEach((word, i) => {
        if (startIndex + i < inputs.length) {
            const targetInput = inputs[startIndex + i];
            targetInput.value = word.toLowerCase();
            window.validateWord(targetInput);
        }
    });
    const nextIndex = Math.min(startIndex + words.length, inputs.length - 1);
    if(inputs[nextIndex]) inputs[nextIndex].focus();
    closeAllLists();
}

function getSeedFromGrid() {
    const inputs = document.querySelectorAll('#seed-grid-container .word-input');
    const words = [];
    for (let i = 0; i < inputs.length; i++) {
        const val = inputs[i].value.trim().toLowerCase();
        if (!val) throw new Error(`Word #${i+1} is missing.`);
        if (bip39Wordlist && bip39Wordlist.length > 0 && !bip39Wordlist.includes(val)) throw new Error(`Word #${i+1} ("${val}") is not a valid BIP-39 word.`);
        words.push(val);
    }
    return words.join(' ');
}

// Initialize Grid on Load
window.addEventListener('DOMContentLoaded', () => {
    window.updateSeedGrid();
});

// === CORE ENCODING LOGIC ===
function encodeSeedToNumeric(seedString) {
    const words = seedString.trim().toLowerCase().split(/\s+/).filter(w => w.length > 0);
    if (words.length !== 12 && words.length !== 24) {
        throw new Error(`Expected 12 or 24 words, but found ${words.length}.`);
    }
    
    let numericString = "";
    for (let word of words) {
        const index = bip39Wordlist.indexOf(word);
        if (index === -1) throw new Error(`Invalid BIP-39 word found: "${word}"`);
        numericString += index.toString().padStart(4, '0');
    }
    return numericString;
}

// === GENERATE SEEDQR ===
document.getElementById('btn-generate').addEventListener('click', async (e) => {
    e.preventDefault();
    const statusBox = document.getElementById('generate-status');
    statusBox.style.display = 'none';

    try {
        const seedInput = getSeedFromGrid();
        currentNumericSeed = encodeSeedToNumeric(seedInput);
        
        const tempCanvas = document.createElement('canvas');
        await QRCode.toCanvas(tempCanvas, [{ data: currentNumericSeed, mode: 'numeric' }], {
            errorCorrectionLevel: 'L',
            margin: 0,
            width: 29, 
            version: 3, 
            color: { dark: '#000000', light: '#ffffff' }
        });
        
        const finalCanvas = document.getElementById('qr-canvas');
        const ctx = finalCanvas.getContext('2d');
        const blockSize = 20; 
        const qrSize = 29 * blockSize; 
        
        const topPadding = 35;  
        const leftPadding = 35; 

        finalCanvas.width = qrSize + leftPadding;
        finalCanvas.height = qrSize + topPadding;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);

        const tempCtx = tempCanvas.getContext('2d');
        const imgData = tempCtx.getImageData(0, 0, 29, 29).data;

        for (let y = 0; y < 29; y++) {
            for (let x = 0; x < 29; x++) {
                const rIndex = (y * 29 + x) * 4;
                const isBlack = imgData[rIndex] === 0;

                ctx.fillStyle = isBlack ? '#000000' : '#ffffff';
                ctx.fillRect(
                    leftPadding + (x * blockSize), 
                    topPadding + (y * blockSize), 
                    blockSize, 
                    blockSize
                );
            }
        }

        ctx.font = '14px monospace';
        ctx.fillStyle = '#888888';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (let i = 0; i <= 29; i++) {
            ctx.beginPath();
            ctx.strokeStyle = i % 5 === 0 ? 'rgba(255, 0, 0, 0.5)' : 'rgba(255, 0, 0, 0.2)';
            ctx.lineWidth = i % 5 === 0 ? 2 : 0.8;
            
            let vx = leftPadding + (i * blockSize);
            ctx.moveTo(vx, topPadding);
            ctx.lineTo(vx, topPadding + qrSize);
            
            let hy = topPadding + (i * blockSize);
            ctx.moveTo(leftPadding, hy);
            ctx.lineTo(leftPadding + qrSize, hy);
            ctx.stroke();

            if (i < 29 && i % 2 === 0) {
                ctx.fillText((i + 1).toString(), leftPadding + (i * blockSize) + (blockSize / 2), topPadding / 2);
                ctx.fillText((i + 1).toString(), leftPadding / 2, topPadding + (i * blockSize) + (blockSize / 2));
            }
        }
        
        document.getElementById('qr-output').style.display = 'flex';
    } catch (err) {
        document.getElementById('qr-output').style.display = 'none';
        statusBox.className = 'status error';
        statusBox.innerText = err.message;
        statusBox.style.display = 'block';
    }
});

// === PRINT BLANK GRID ===
document.getElementById('btn-print-blank').addEventListener('click', (e) => {
    e.preventDefault();
    let svg = `<svg width="800" height="800" viewBox="-2 -2 33 33" xmlns="http://www.w3.org/2000/svg">`;
    svg += `<rect width="29" height="29" fill="white" stroke="black" stroke-width="0.1" />`;

    const drawAnchor = (cx, cy) => {
        svg += `<rect x="${cx}" y="${cy}" width="7" height="7" fill="black" />`;
        svg += `<rect x="${cx+1}" y="${cy+1}" width="5" height="5" fill="white" />`;
        svg += `<rect x="${cx+2}" y="${cy+2}" width="3" height="3" fill="black" />`;
    };
    
    drawAnchor(0, 0); 
    drawAnchor(22, 0); 
    drawAnchor(0, 22); 

    for (let i = 0; i <= 29; i++) {
        let strokeWidth = i % 5 === 0 ? 0.08 : 0.03;
        let strokeColor = i % 5 === 0 ? '#000000' : '#888888';
        svg += `<line x1="${i}" y1="0" x2="${i}" y2="29" stroke="${strokeColor}" stroke-width="${strokeWidth}" />`;
        svg += `<line x1="0" y1="${i}" x2="29" y2="${i}" stroke="${strokeColor}" stroke-width="${strokeWidth}" />`;
    }

    for(let i=0; i<29; i++) {
         if (i % 2 === 0) {
             svg += `<text x="${i + 0.5}" y="-0.3" font-size="0.6" text-anchor="middle" fill="#555" font-family="monospace">${i+1}</text>`;
             svg += `<text x="-0.3" y="${i + 0.7}" font-size="0.6" text-anchor="end" fill="#555" font-family="monospace">${i+1}</text>`;
         }
    }

    svg += `</svg>`;
    document.getElementById('blank-grid-container').innerHTML = svg;
    window.print();
});

// === CUSTOM CAMERA LOGIC ===
let html5QrCodeImport;
document.getElementById('btn-camera-import').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('camera-import-box').style.display = 'block';
    html5QrCodeImport = new Html5Qrcode("reader-import");
    
    html5QrCodeImport.start(
        { facingMode: "environment" }, 
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => {
            html5QrCodeImport.stop().then(() => {
                document.getElementById('camera-import-box').style.display = 'none';
            }).catch(console.error);
            
            const words = decodedText.trim().split(/[\s\n]+/);
            if (words.length === 24) document.querySelector('input[name="seedLength"][value="24"]').checked = true;
            else document.querySelector('input[name="seedLength"][value="12"]').checked = true;
            window.updateSeedGrid();
            setTimeout(() => fillPastedWords(words, 0), 50);
        },
        (errorMessage) => { /* ignore normal scanning errors */ }
    ).catch((err) => {
        alert("Camera error: " + err);
    });
});
document.getElementById('btn-cancel-import').addEventListener('click', (e) => {
    e.preventDefault();
    if(html5QrCodeImport) {
        html5QrCodeImport.stop().then(() => {
            document.getElementById('camera-import-box').style.display = 'none';
        }).catch(err => console.log(err));
    }
});

// === DECRYPT SECURE NOTE (.skb) ===
const enc = new TextEncoder();
const dec = new TextDecoder();

async function getPasswordKey(password, salt) {
    const keyMat = await crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
    return await crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
        keyMat, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
}

function base64ToBuffer(base64) {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

document.getElementById('btn-show-decrypt').addEventListener('click', (e) => {
    e.preventDefault();
    const box = document.getElementById('decrypt-box');
    box.style.display = box.style.display === 'none' ? 'block' : 'none';
});

document.getElementById('btn-process-decrypt').addEventListener('click', async (e) => {
    e.preventDefault();
    const fileInput = document.getElementById('decrypt-file');
    const password = document.getElementById('decrypt-password').value;
    const statusBox = document.getElementById('decrypt-status');
    
    if (!fileInput.files.length || !password) {
        statusBox.className = 'status error'; statusBox.innerText = 'File and password required.'; 
        statusBox.style.display = 'block';
        return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = JSON.parse(e.target.result);
            const salt = base64ToBuffer(data.salt);
            const iv = base64ToBuffer(data.iv);
            const ciphertext = base64ToBuffer(data.ciphertext);

            const key = await getPasswordKey(password, salt);
            const decryptedBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, ciphertext);
            const htmlString = dec.decode(decryptedBuffer);

            const tempDiv = document.createElement("div");
            tempDiv.innerHTML = htmlString;
            const rawText = tempDiv.innerText.toLowerCase();
            
            const cleanText = rawText.replace(/[^a-z\s]/g, ' ');
            const allWords = cleanText.split(/\s+/).filter(w => w.length > 0);
            
            let foundWords = [];
            let currentStreak = [];
            
            for (let word of allWords) {
                if (bip39Wordlist.includes(word)) {
                    currentStreak.push(word);
                } else {
                    if (currentStreak.length >= 12) {
                        foundWords = currentStreak;
                        break; 
                    }
                    currentStreak = []; 
                }
            }
            if (foundWords.length === 0 && currentStreak.length >= 12) {
                foundWords = currentStreak;
            }
            
            if (foundWords.length > 0) {
                if (foundWords.length === 24) document.querySelector('input[name="seedLength"][value="24"]').checked = true;
                else document.querySelector('input[name="seedLength"][value="12"]').checked = true;
                
                window.updateSeedGrid();
                setTimeout(() => fillPastedWords(foundWords, 0), 10);

                if (foundWords.length === 12 || foundWords.length === 24) {
                    statusBox.className = 'status success'; 
                    statusBox.innerText = `Found a perfect ${foundWords.length}-word sequence! Grid populated.`;
                    setTimeout(() => { document.getElementById('decrypt-box').style.display = 'none'; }, 2000);
                } else {
                    statusBox.className = 'status success'; 
                    statusBox.style.color = "var(--orange)";
                    statusBox.style.borderColor = "var(--orange)";
                    statusBox.style.backgroundColor = "rgba(247, 147, 26, 0.1)";
                    statusBox.innerText = `Found ${foundWords.length} words. Populated grid, but check for extra words.`;
                }
                statusBox.style.display = 'block';
            } else {
                statusBox.className = 'status error'; 
                statusBox.innerText = 'Could not find a sequence of 12 or 24 BIP-39 words.';
                statusBox.style.display = 'block';
            }
        } catch (err) {
            statusBox.className = 'status error'; 
            statusBox.innerText = 'Decryption failed. Wrong password or corrupted file.';
            statusBox.style.display = 'block';
        }
    };
    reader.readAsText(fileInput.files[0]);
});

// === VERIFY HAND-DRAWN QR ===
let html5QrCodeVerify;
document.getElementById('btn-start-verify').addEventListener('click', (e) => {
    e.preventDefault();
    if (!currentNumericSeed) {
        alert("Generate a SeedQR first to verify against!"); return;
    }
    
    document.getElementById('camera-verify-box').style.display = 'block';
    document.getElementById('verify-result').innerText = '';
    
    html5QrCodeVerify = new Html5Qrcode("reader-verify");
    html5QrCodeVerify.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (scannedText) => {
            html5QrCodeVerify.stop().then(() => {
                document.getElementById('camera-verify-box').style.display = 'none';
            }).catch(console.error);
            
            const resBox = document.getElementById('verify-result');
            resBox.style.background = 'var(--card2)';

            let normalizedScan = scannedText.trim();

            // If the scanned text contains letters, it's a standard text seed.
            // We need to encode it to numeric format to match the Compact SeedQR standard.
            if (/[a-zA-Z]/.test(normalizedScan)) {
                try {
                    normalizedScan = encodeSeedToNumeric(normalizedScan);
                } catch (err) {
                    console.warn("Could not encode scanned text to numeric format:", err);
                }
            }

            // Now compare apples to apples (Numeric to Numeric)
            if (normalizedScan === currentNumericSeed) {
                resBox.style.color = "var(--teal)";
                resBox.innerText = "✅ SUCCESS! Perfect match.";
                resBox.style.border = "1px solid var(--teal)";
            } else {
                resBox.style.color = "var(--red)";
                resBox.innerText = `❌ FAILED. Codes do not match.`;
                resBox.style.border = "1px solid var(--red)";
            }
        },
        (errorMessage) => { /* ignore */ }
    );
});

document.getElementById('btn-cancel-verify').addEventListener('click', (e) => {
    e.preventDefault();
    if(html5QrCodeVerify) {
        html5QrCodeVerify.stop().then(() => {
            document.getElementById('camera-verify-box').style.display = 'none';
        }).catch(err => console.log(err));
    }
});