我都不敢用通达信了，这BS又显示不出来。别提什么没登录没刷新网速卡，我可以保证没有这些情况。实在不行招大学刚毕业的实习生+claude技术重构，重写代码吧，你们实在被那帮老混子程序员以及产品经理拉帮结派绑架太深了，被他们绑架的沉没成本太高了。以前会敲个Hello World就能应聘个程序员，那些吃白食这么久没有技术含量，2年没敲代码的人养他们当吉娃娃吉祥物吗。bug就是bug，100%可复现，我真是不敢用通达信。


HJ_1:=(CLOSE-LLV(LOW,20))/(HHV(HIGH,20)-LLV(LOW,20))*100;
HJ_2:=SMA(SMA(HJ_1,3,1),3,1)/28.57;
HJ_3:=EMA(HJ_2,5);
HJ_4:=3*HJ_2-2*HJ_3;
HJ_5:=CROSS(HJ_4,HJ_2) AND HJ_2<2.1 AND CLOSE>OPEN;
 
HJ_6:=CROSS(HJ_4,HJ_2) AND HJ_2<2.1 AND CLOSE>OPEN;
HJ_7:=(2*CLOSE+HIGH+LOW)/4;
HJ_8:=LLV(LOW,13);
HJ_9:=HHV(HIGH,13);
HJ_10:=EMA((HJ_7-HJ_8)/(HJ_9-HJ_8)*100,13);
HJ_11:=EMA(0.667*REF(HJ_10,1)+0.333*HJ_10,2);
HJ_12:=HJ_10;

STICKLINE(HJ_10>HJ_11,HJ_10,HJ_11,3,1),COLORRED;
STICKLINE(HJ_10<=HJ_11,HJ_10,HJ_11,3,1),COLOR000000;

HJ_13:=10;
柱始: HJ_11,COLORBLUE,NODRAW;
中轨:50,COLORYELLOW;
柱终: HJ_10,COLORBLUE,NODRAW;
{滑:EMA(0.382*REF(HJ_10,2)+0.618*HJ_10,6),COLORRED;
IF(滑>REF(滑,1),滑,DRAWNULL)COLORGREEN,LINETHICK2;
IF(滑<REF(滑,1),滑,DRAWNULL),COLORGREEN,LINETHICK2;}
 
 
HJ_14:=REF(CLOSE,1);
HJ_15:=SMA(MAX(CLOSE-HJ_14,0),6,1)/SMA(ABS(CLOSE-HJ_14),6,1)*100;
HJ_16:=CROSS(70,HJ_15)*70;
 
顶:80,COLORBLACK;
底:20, COLORBLACK;
中:50,POINTDOT,COLORBLACK;
{DRAWTEXT(ISLASTBAR,0,'空'),COLORGREEN;
DRAWTEXT(ISLASTBAR,0,'多'),COLORRED;
DRAWTEXT(ISLASTBAR,0,'中'),COLORWHITE;};




{---------- 趋势加速/减速文字标记 ----------}
加速值:=HJ_10/REF(HJ_10,1)*100;
加速度变化:=加速值-REF(加速值,1);

DRAWTEXT(加速度变化>0 AND 加速值>100, 0, '+'), COLORRED;     {上涨加速，红色+}
DRAWTEXT(加速度变化<0 AND 加速值>100, 0, '-'), COLORGREEN;   {上涨减速，绿色-}
DRAWTEXT(加速度变化>0 AND 加速值<100, 0, '+'), COLORGREEN;   {下跌减缓，绿色+}
DRAWTEXT(加速度变化<0 AND 加速值<100, 0, '-'), COLORGREEN;   {下跌加速，绿色-};