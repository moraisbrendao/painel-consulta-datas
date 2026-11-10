Attribute VB_Name = "ExportarPainel"
' =====================================================================
' Exportar para o painel
' Gera o arquivo "painel_entregas.csv" (na mesma pasta da planilha)
' com os pedidos da aba "Pedidos" + o retorno mais recente da aba
' "Retornos". Depois e so enviar esse arquivo no painel.
'
' Como instalar (uma vez): Alt+F11 > Arquivo > Importar arquivo >
' escolha este ExportarPainel.bas. Depois crie um botao na planilha
' (Desenvolvedor > Inserir > Botao) e associe a macro ExportarParaPainel.
' =====================================================================
Option Explicit

Public Sub ExportarParaPainel()
    Dim wsP As Worksheet, wsR As Worksheet
    Set wsP = ThisWorkbook.Worksheets("Pedidos")
    Set wsR = ThisWorkbook.Worksheets("Retornos")

    Application.ScreenUpdating = False
    Application.StatusBar = "Exportando para o painel..."

    ' ---- 1) Retorno mais recente de cada pedido (aba Retornos) ----
    Dim ret As Object: Set ret = CreateObject("Scripting.Dictionary")
    ret.CompareMode = vbTextCompare
    Dim rA As Long, rB As Long, rD As Long
    rA = AcharColuna(wsR, "Pedido Intelipost")
    rB = AcharColuna(wsR, "Retorno da ocorrencia")
    rD = AcharColuna(wsR, "Data do retorno")

    Dim ultR As Long, i As Long, ped As String, dt As Variant, ant As Variant
    ultR = wsR.Cells(wsR.Rows.Count, rA).End(xlUp).Row
    Dim dadosR As Variant
    dadosR = wsR.Range(wsR.Cells(1, 1), wsR.Cells(ultR, Application.Max(rA, rB, rD))).Value
    For i = 2 To ultR
        ped = Trim$(CStr(dadosR(i, rA)))
        If ped <> "" Then
            dt = dadosR(i, rD)
            ' linhas mais abaixo (mais novas) substituem as antigas,
            ' a nao ser que tenham data de retorno menor
            If ret.Exists(ped) Then
                ant = ret(ped)
                If IsDate(dt) And IsDate(ant(1)) Then
                    If CDate(dt) < CDate(ant(1)) Then GoTo proximo
                End If
            End If
            ret(ped) = Array(Texto(dadosR(i, rB)), dt)
        End If
proximo:
    Next i

    ' ---- 2) Colunas da aba Pedidos (procuradas pelo nome do cabecalho) ----
    Dim cPed&, cCanalPed&, cNota&, cCanal&, cTransp&, cStatus&, cPrevO&, cPrevA&
    Dim cEntrega&, cTratado&, cRetTransp&, cUF&, cCidade&, cLink&
    cPed = AcharColuna(wsP, "Pedido Intelipost")
    cCanalPed = AcharColuna(wsP, "Pedido Anymarket")
    cNota = AcharColuna(wsP, "Nota-S" & ChrW(233) & "rie")
    cCanal = AcharColuna(wsP, "Canal")
    cTransp = AcharColuna(wsP, "Transportadora")
    cStatus = AcharColuna(wsP, "Status")
    cPrevO = AcharColuna(wsP, "Prev. Original")
    cPrevA = AcharColuna(wsP, "Prev. Atual")
    cEntrega = AcharColuna(wsP, "Data Entrega")
    cTratado = AcharColuna(wsP, "Retorno Tratado")
    cRetTransp = AcharColuna(wsP, "Retorno Transportadora")
    cUF = AcharColuna(wsP, "UF")
    cCidade = AcharColuna(wsP, "Cidade")
    cLink = AcharColuna(wsP, "Link Rastreio")

    Dim ultP As Long
    ultP = wsP.Cells(wsP.Rows.Count, cPed).End(xlUp).Row
    Dim d As Variant
    d = wsP.Range(wsP.Cells(1, 1), wsP.Cells(ultP, wsP.Cells(1, wsP.Columns.Count).End(xlToLeft).Column)).Value

    ' ---- 3) Monta o CSV ----
    Dim partes() As String, linha As String, n As Long
    ReDim partes(0 To ultP)
    partes(0) = "pedido;pedido_canal;nota;canal;transportadora;status;prev_original;prev_atual;data_entrega;" & _
         "nova_data;retorno;retorno_texto;data_retorno;uf;cidade;link_rastreio"

    Dim tratado As Variant, novaData As String, retorno As String
    Dim retTexto As String, dataRet As String
    For i = 2 To ultP
        ped = Trim$(CStr(d(i, cPed)))
        If ped <> "" Then
            tratado = d(i, cTratado)
            novaData = "": retorno = ""
            If ParaISO(tratado) <> "" Then
                novaData = ParaISO(tratado)
            ElseIf Not IsError(tratado) And VarType(tratado) <> vbDate Then
                retorno = Trim$(CStr(tratado))
            End If

            retTexto = "": dataRet = ""
            If ret.Exists(ped) Then
                ant = ret(ped)
                retTexto = ant(0)
                dataRet = ParaISO(ant(1))
            ElseIf ParaISO(d(i, cRetTransp)) = "" And Not IsError(d(i, cRetTransp)) Then
                retTexto = Texto(d(i, cRetTransp))
            End If

            linha = Q(ped) & ";" & Q(d(i, cCanalPed)) & ";" & Q(d(i, cNota)) & ";" & _
                    Q(d(i, cCanal)) & ";" & Q(d(i, cTransp)) & ";" & Q(d(i, cStatus)) & ";" & _
                    ParaISO(d(i, cPrevO)) & ";" & ParaISO(d(i, cPrevA)) & ";" & ParaISO(d(i, cEntrega)) & ";" & _
                    novaData & ";" & Q(retorno) & ";" & Q(retTexto) & ";" & dataRet & ";" & _
                    Q(d(i, cUF)) & ";" & Q(d(i, cCidade)) & ";" & Q(d(i, cLink))
            n = n + 1
            partes(n) = linha
        End If
    Next i

    ' ---- 4) Salva em UTF-8 (para manter os acentos) ----
    Dim caminho As String
    caminho = ThisWorkbook.Path & Application.PathSeparator & "painel_entregas.csv"
    Dim st As Object: Set st = CreateObject("ADODB.Stream")
    st.Type = 2: st.Charset = "utf-8": st.Open
    ReDim Preserve partes(0 To n)
    st.WriteText Join(partes, vbCrLf) & vbCrLf
    st.SaveToFile caminho, 2
    st.Close

    Application.StatusBar = False
    Application.ScreenUpdating = True
    MsgBox n & " pedidos exportados." & vbCrLf & vbCrLf & _
           "Arquivo: " & caminho & vbCrLf & vbCrLf & _
           "Agora abra o painel, entre com o seu login e clique em ""Enviar planilha"".", _
           vbInformation, "Exportar para o painel"
End Sub

' Procura o cabecalho na linha 1 (primeira ocorrencia)
Private Function AcharColuna(ws As Worksheet, nome As String) As Long
    Dim c As Range
    Set c = ws.Rows(1).Find(What:=nome, LookIn:=xlValues, LookAt:=xlWhole, MatchCase:=False, _
                            SearchOrder:=xlByColumns, SearchDirection:=xlNext, After:=ws.Cells(1, ws.Columns.Count))
    If c Is Nothing Then
        Err.Raise vbObjectError + 1, , "N" & ChrW(227) & "o achei a coluna """ & nome & """ na aba " & ws.Name & "."
    End If
    AcharColuna = c.Column
End Function

' Converte data (ou texto dd/mm/aaaa) para aaaa-mm-dd; senao devolve ""
Private Function ParaISO(v As Variant) As String
    Dim s As String
    If IsError(v) Or IsEmpty(v) Then Exit Function
    If VarType(v) = vbDate Then
        If CDbl(v) >= 1 Then ParaISO = Format$(v, "yyyy-mm-dd")
        Exit Function
    End If
    s = Trim$(CStr(v))
    If s Like "##/##/####" Then
        ParaISO = Mid$(s, 7, 4) & "-" & Mid$(s, 4, 2) & "-" & Left$(s, 2)
    End If
End Function

' Coloca o texto entre aspas para o CSV
Private Function Q(v As Variant) As String
    Dim s As String
    If IsError(v) Or IsEmpty(v) Then Exit Function
    s = Trim$(CStr(v))
    s = Replace(Replace(s, vbCr, " "), vbLf, " ")
    Q = """" & Replace(s, """", """""") & """"
End Function

' Texto do retorno (se a transportadora mandou so uma data, vira dd/mm/aaaa)
Private Function Texto(v As Variant) As String
    If IsError(v) Or IsEmpty(v) Then Exit Function
    If VarType(v) = vbDate Then
        Texto = Format$(v, "dd/mm/yyyy")
    Else
        Texto = Trim$(CStr(v))
    End If
End Function
